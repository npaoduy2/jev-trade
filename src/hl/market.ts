import { ApiRequestError, ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { formatPrice, formatSize, SymbolConverter } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { config } from "../config";
import type { HigherTf } from "../timeframes";
import { FillPnlBook, type FillPnlLike, type VenueAccount } from "../account";
import { accountFromClearinghouse, fillDir, spotUsdc, type ClearinghouseLike, type SpotStateLike, type SpotUsdc } from "./account";
import { gridFromTick, quotePrice, takerPrice, type PriceGrid } from "../book";
import { sameCoin, type SleeveConfig } from "../sleeves";
import type { Book, OrderId, Quote, Side } from "../types";
import type { VenueFillPrint, VenueMarket } from "../venue";
import type { HlFeed } from "./feed";
import { info } from "./rest";

type Ex = ExchangeClient;

type QuoteBase = Required<Pick<Quote, "side" | "reduceOnly" | "capped" | "taker">>;

/** Hyperliquid's perp tick: 10^-(6 - szDecimals). BTC szDecimals=5 => 0.1. */
export function hlGrid(szDecimals: number): PriceGrid {
  return gridFromTick(10 ** -Math.max(0, 6 - szDecimals));
}

/** Hyperliquid perp: Alo post-only quotes, modify when the side stays put. */
export class HlMarket implements VenueMarket {
  readonly wallet: PrivateKeyAccount | null;
  readonly coin: string;
  readonly pair: string;
  readonly label: string;
  margin = { usdc: 0 };
  account: VenueAccount | null = null;
  szDecimals = 5;
  grid: PriceGrid = hlGrid(5);
  maxLeverage = 50;
  /** Venue fee rates, read at init. Defaults are the standard tier. */
  takerFeeBps = 4.5;
  makerFeeBps = 1.5;
  private infoClient: InfoClient;
  private ex: Ex | null = null;
  private assetId = 0;
  private lastOid: number | null = null;
  private lastSide: Side | null = null;
  private lastPrice = 0;
  private lastSize = 0;
  private lastReduce = false;
  private fills = new FillPnlBook();
  private lastCh: ClearinghouseLike | null = null;
  /** Shared collateral pool. Kept across clearinghouse pushes so equity does not flap. */
  private spot: SpotUsdc | null = null;
  readonly fillPrints: VenueFillPrint[] = [];
  onVenueFill: ((fill: VenueFillPrint) => void) | null = null;

  get liveKey() {
    return this.wallet != null;
  }

  get sizeDecimals() {
    return this.szDecimals;
  }

  get chartPoints() {
    return this.feed.chart.points;
  }

  get assetCtx() {
    return this.feed.assetCtx;
  }

  candleCloses(limit = 500) {
    return this.feed.chart.closes(limit);
  }

  /** Closes for one higher interval. 1m stays on the live candle socket. */
  tfCloses(tf: HigherTf) {
    return this.feed.tfs.series(tf);
  }

  constructor(private feed: HlFeed, sleeve: SleeveConfig) {
    this.coin = sleeve.coin;
    this.pair = sleeve.pair;
    this.label = sleeve.label;
    this.wallet = config.dryRun || !sleeve.privateKey ? null : privateKeyToAccount(sleeve.privateKey as `0x${string}`);
    const transport = new HttpTransport({ isTestnet: config.hlTestnet });
    this.infoClient = new InfoClient({ transport });
    if (this.wallet) this.ex = new ExchangeClient({ transport, wallet: this.wallet });
  }

  get address() {
    return this.wallet?.address ?? null;
  }

  /**
   * Exposure for one entry, scaled by the leverage rung Jev picked. Conviction has
   * to reach the notional to reach the PnL: the venue multiplies size by the price
   * move, never by leverage. Margin stays `quoteUsd` at every rung, since notional
   * is `quoteUsd * lev` and initial margin is notional over lev.
   */
  quoteSize(mid: number, leverage = 1): number {
    const rung = Math.max(1, Math.min(this.maxLeverage, Math.floor(Number(leverage) || 1)));
    const notional = Math.min(config.quoteUsd * rung, config.maxNotionalUsd);
    return lot(notional / Math.max(mid, 1e-9), this.szDecimals);
  }

  async init() {
    const transport = new HttpTransport({ isTestnet: config.hlTestnet });
    const converter = await SymbolConverter.create({ transport });
    const assetId = converter.getAssetId(this.coin);
    const szDecimals = converter.getSzDecimals(this.coin);
    if (assetId == null || szDecimals == null) throw new Error(`unknown Hyperliquid coin ${this.coin}`);
    this.assetId = assetId;
    this.szDecimals = szDecimals;
    this.grid = hlGrid(szDecimals);
    if (this.wallet && this.ex) {
      this.feed.onClearinghouse = (state) => this.applyClearinghouse(state);
      this.feed.onSpotState = (state) => this.applySpot(state);
      this.feed.onUserPnl = (fill) => this.noteFill(fill);
      this.feed.watchUser(this.wallet.address);
      this.feed.onGone = (oid) => {
        if (this.lastOid === oid) this.forgetResting();
      };
      await this.cancelOpen();
    }
    await this.loadMaxLeverage();
    await this.loadFees();
    await this.refresh();
    if (this.address) await this.seedFills();
    const net = config.hlTestnet ? "testnet" : "mainnet";
    console.log(`hyperliquid ${this.pair} ${net} ${this.coin} asset ${this.assetId} szDecimals ${this.szDecimals} max ${this.maxLeverage}x ${config.dryRun ? "DRY RUN" : `wallet ${this.address}`}`);
    if (this.wallet) {
      const a = this.account;
      const side = !a || !a.positionSz ? "flat" : a.positionSz > 0 ? "long" : "short";
      const size = a ? Math.abs(a.positionSz) : 0;
      const entry = a?.entryPrice != null ? ` @ ${a.entryPrice}` : "";
      console.log(`${this.label} equity $${(a?.accountValue ?? 0).toFixed(2)} available $${this.margin.usdc.toFixed(2)} perps $${(a?.perpsValue ?? 0).toFixed(2)} ${side} ${size} ${this.coin}${entry}`);
    }
  }

  /** Fee tier from the venue, so the cost of crossing is the real one. */
  private async loadFees() {
    if (!this.wallet) return;
    try {
      const f = await info<{ userCrossRate?: string; userAddRate?: string }>({
        type: "userFees",
        user: this.wallet.address,
      });
      const cross = Number(f.userCrossRate), add = Number(f.userAddRate);
      if (Number.isFinite(cross) && cross >= 0) this.takerFeeBps = cross * 10_000;
      if (Number.isFinite(add) && add >= 0) this.makerFeeBps = add * 10_000;
    } catch {
      // keep the defaults
    }
  }

  /**
   * Ask the venue what is still on the book for this coin and cancel all of it.
   * `cancelResting` only knows the id it last saw, and a partial fill reports
   * `filled` on orderUpdates, which drops that id while the remainder rests on.
   */
  async cancelOpen(): Promise<OrderId[]> {
    if (!this.wallet || !this.ex) return [];
    try {
      const opens = await this.infoClient.openOrders({ user: this.wallet.address });
      const mine = opens.filter((o) => sameCoin(o.coin, this.coin));
      if (!mine.length) return [];
      await this.ex.cancel({ cancels: mine.map((o) => ({ a: this.assetId, o: o.oid })) });
      this.forgetResting();
      return mine.map((o) => o.oid);
    } catch {
      // next quote will replace if we still see them
      return [];
    }
  }

  applyClearinghouse(state: ClearinghouseLike) {
    this.lastCh = state;
    this.recompute();
  }

  applySpot(state: SpotStateLike) {
    const next = spotUsdc(state);
    if (!next) return;
    this.spot = next;
    this.recompute();
  }

  /** Equity needs the perps leg and the spot pool together, and they arrive separately. */
  private recompute() {
    if (!this.lastCh) return;
    this.account = this.fills.apply(accountFromClearinghouse(this.lastCh, this.coin, this.account, this.spot));
    this.margin.usdc = this.account.withdrawable;
  }

  noteFill(fill: FillPnlLike) {
    if (!this.fills.add(fill, this.coin)) return;
    if (this.account) this.account = this.fills.apply(this.account);
    const ts = Number(fill.time);
    const price = Number(fill.px);
    const size = Number(fill.sz);
    const side: Side | null =
      fill.side === "B" || fill.side === "buy" ? "buy" : fill.side === "A" || fill.side === "sell" ? "sell" : null;
    if (side && Number.isFinite(ts) && ts > 0 && Number.isFinite(price) && price > 0) {
      const hash = typeof fill.hash === "string" && fill.hash ? fill.hash : undefined;
      const closedPnl = Number(fill.closedPnl);
      const feeUsd = Number(fill.fee);
      const print: VenueFillPrint = {
        ts,
        side,
        price,
        size: Number.isFinite(size) ? size : 0,
        dir: fillDir(fill.dir),
        hash,
        ...(Number.isFinite(closedPnl) ? { closedPnl } : {}),
        ...(Number.isFinite(feeUsd) ? { feeUsd } : {}),
      };
      this.fillPrints.push(print);
      if (this.feed.chart.addFill(print)) this.onVenueFill?.(print);
    }
  }

  private async seedFills() {
    if (!this.address) return;
    try {
      const fills = await this.infoClient.userFills({ user: this.address });
      for (const f of fills) this.noteFill(f);
    } catch {
      // keep whatever WS has already delivered
    }
  }

  async refresh() {
    const user = this.address;
    if (!user) return;
    const [ch, spot] = await Promise.allSettled([
      this.infoClient.clearinghouseState({ user }),
      this.infoClient.spotClearinghouseState({ user }),
    ]);
    // Spot first so the clearinghouse recompute already sees the pool.
    if (spot.status === "fulfilled") {
      const next = spotUsdc(spot.value);
      if (next) this.spot = next;
    }
    if (ch.status === "fulfilled") this.applyClearinghouse(ch.value);
    else this.recompute();
  }

  readBook(): Book {
    if (!this.feed.book) throw new Error(`no Hyperliquid book yet for ${this.coin}`);
    return this.feed.book;
  }

  async setLeverage(raw: number): Promise<number> {
    const leverage = Math.max(1, Math.min(this.maxLeverage, Math.round(raw)));
    if (!this.ex) return leverage;
    if (this.account?.leverage === leverage) return leverage;
    try {
      await this.ex.updateLeverage({ asset: this.assetId, isCross: true, leverage });
      if (this.account) this.account.leverage = leverage;
      return leverage;
    } catch (e) {
      console.warn(`${this.label} leverage: ${(e as Error).message.slice(0, 160)}`);
      return this.account?.leverage ?? leverage;
    }
  }

  /** Entries rest post-only. Exits cross as Ioc so they do not wait on a taker. */
  async send(side: Side, sizeSz: number, book: Book, cancel: OrderId[], reduceOnly = false, taker = false): Promise<Quote> {
    const size = lot(sizeSz, this.szDecimals);
    const base: QuoteBase = { side, reduceOnly, capped: false, taker };
    if (size <= 0) {
      return { ...base, price: 0, size: 0, txHash: null, cancel, status: "reverted", orderId: null };
    }
    const px = taker
      ? Number(formatPrice(takerPrice(side, book, this.grid), this.szDecimals))
      : this.restingPx(side, book);
    if (!this.ex) {
      return { ...base, price: px, size, txHash: null, cancel, status: "sim", orderId: null };
    }
    return taker ? this.sendTaker(size, px, base) : this.sendMaker(size, px, oids(cancel), base);
  }

  /** Post-only price, clamped so it can never cross and get rejected. */
  private restingPx(side: Side, book: Book): number {
    let px = Number(formatPrice(quotePrice(side, book, this.grid), this.szDecimals));
    if (side === "sell" && px <= book.bid) px = Number(formatPrice(book.ask, this.szDecimals));
    if (side === "buy" && px >= book.ask) px = Number(formatPrice(book.bid, this.szDecimals));
    return px;
  }

  private limitOrder(side: Side, size: number, px: number, reduceOnly: boolean, tif: "Alo" | "Ioc") {
    return {
      a: this.assetId,
      b: side === "buy",
      p: formatPrice(px, this.szDecimals),
      s: formatSize(size, this.szDecimals),
      r: reduceOnly,
      t: { limit: { tif } },
    };
  }

  private async sendTaker(size: number, px: number, base: QuoteBase): Promise<Quote> {
    // The standing entry sits on the far side of an exit. Pull it before crossing.
    const open = this.lastOid;
    const cancel: OrderId[] = open != null ? [open] : [];
    if (open != null) {
      await this.ex!.cancel({ cancels: [{ a: this.assetId, o: open }] }).catch(() => {});
      this.forgetResting();
    }
    try {
      const res = await this.ex!.order({
        orders: [this.limitOrder(base.side, size, px, base.reduceOnly, "Ioc")],
        grouping: "na",
      });
      const st = res.response.data.statuses[0];
      if (st && typeof st === "object" && "filled" in st) {
        return {
          ...base,
          price: Number(st.filled.avgPx) || px,
          size: Number(st.filled.totalSz) || size,
          txHash: null,
          cancel,
          status: "placed",
          orderId: st.filled.oid,
        };
      }
      // An unfilled Ioc leaves nothing behind. Next tick decides again.
      return { ...base, price: px, size, txHash: null, cancel, status: "reverted", orderId: null };
    } catch (e) {
      this.warn("exit", e);
      return { ...base, price: px, size, txHash: null, cancel, status: "reverted", orderId: null };
    }
  }

  private async sendMaker(size: number, px: number, cancel: number[], base: QuoteBase): Promise<Quote> {
    const { side, reduceOnly } = base;
    if (
      this.lastOid != null &&
      this.lastSide === side &&
      this.lastPrice === px &&
      this.lastSize === size &&
      this.lastReduce === reduceOnly
    ) {
      return { ...base, price: px, size, txHash: null, cancel: [], status: "placed", orderId: this.lastOid, unchanged: true };
    }

    const order = this.limitOrder(side, size, px, reduceOnly, "Alo");
    try {
      if (this.lastOid != null && this.lastSide === side && this.lastReduce === reduceOnly) {
        await this.ex!.modify({ oid: this.lastOid, order });
        this.lastPrice = px;
        this.lastSize = size;
        return { ...base, price: px, size, txHash: null, cancel: [], status: "placed", orderId: this.lastOid };
      }

      const open = this.lastOid != null ? [this.lastOid] : cancel.filter((id) => id > 0);
      if (open.length) {
        await this.ex!.cancel({ cancels: open.map((o) => ({ a: this.assetId, o })) }).catch(() => {});
        this.lastOid = null;
      }

      const res = await this.ex!.order({ orders: [order], grouping: "na" });
      const st = res.response.data.statuses[0];
      if (st && typeof st === "object" && "resting" in st) {
        this.lastOid = st.resting.oid;
        this.lastSide = side;
        this.lastPrice = px;
        this.lastSize = size;
        this.lastReduce = reduceOnly;
        return { ...base, price: px, size, txHash: null, cancel: open, status: "placed", orderId: this.lastOid };
      }
      if (st && typeof st === "object" && "filled" in st) {
        this.forgetResting();
        return { ...base, price: px, size, txHash: null, cancel: open, status: "placed", orderId: st.filled.oid };
      }
      this.forgetResting();
      return { ...base, price: px, size, txHash: null, cancel: open, status: "reverted", orderId: null };
    } catch (e) {
      this.warn("quote", e);
      return { ...base, price: px, size, txHash: null, cancel, status: "reverted", orderId: this.lastOid };
    }
  }

  /** Pull the standing quote. A resting order Jev no longer wants still gets hit. */
  async cancelResting(): Promise<OrderId[]> {
    const oid = this.lastOid;
    if (!this.ex || oid == null) return [];
    await this.ex.cancel({ cancels: [{ a: this.assetId, o: oid }] }).catch(() => {});
    this.forgetResting();
    return [oid];
  }

  private forgetResting() {
    this.lastOid = null;
    this.lastSide = null;
    this.lastPrice = 0;
    this.lastSize = 0;
    this.lastReduce = false;
  }

  private warn(what: string, e: unknown) {
    const msg = e instanceof ApiRequestError ? e.message : (e as Error).message;
    if (/rate.?limit/i.test(msg)) console.warn(`${this.label}: hyperliquid rate limited; ${what} skipped`);
    else console.warn(`${this.label} ${what}: ${msg.slice(0, 180)}`);
  }

  private async loadMaxLeverage() {
    try {
      const meta = await info<{ universe?: { name?: string; maxLeverage?: number }[] }>({ type: "meta" });
      const n = Number(meta.universe?.find((u) => u.name === this.coin)?.maxLeverage);
      if (Number.isFinite(n) && n >= 1) this.maxLeverage = Math.floor(n);
    } catch {
      // keep 50
    }
  }
}

/** Hyperliquid order handles are numbers. Anything else came from a sim fill. */
function oids(ids: OrderId[]): number[] {
  return ids.filter((id): id is number => typeof id === "number");
}

function lot(raw: number, szDecimals: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  try {
    return Number(formatSize(raw, szDecimals));
  } catch {
    return 0;
  }
}
