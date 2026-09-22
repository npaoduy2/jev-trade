import { config, type OkxCredentials } from "../config";
import { FillPnlBook, type VenueAccount } from "../account";
import { quotePrice, takerPrice } from "../book";
import type { HigherTf } from "../timeframes";
import type { Book, OrderId, Quote, Side } from "../types";
import { toLot, type VenueFillPrint, type VenueMarket } from "../venue";
import type { SleeveConfig } from "../sleeves";
import { accountFromOkx, okxFill, type BalanceRow, type FillRow, type PositionRow } from "./account";
import type { OkxFeed } from "./feed";
import { formatContracts, formatPx, orderContracts, toBase, type OkxInstrument } from "./instrument";
import { isRateLimited, OkxClient, OkxError } from "./rest";

type QuoteBase = Required<Pick<Quote, "side" | "reduceOnly" | "capped" | "taker">>;

interface OrderAck { ordId?: string; sCode?: string; sMsg?: string }
interface OrderRow { state?: string; avgPx?: string; accFillSz?: string }
interface PendingRow { ordId?: string; instId?: string }
interface FeeRow { maker?: string; taker?: string }
interface AccountConfigRow { uid?: string; posMode?: string; acctLv?: string }

/** Cross margin on a unified account, which is what a shared collateral pool means. */
const TD_MODE = "cross";

/**
 * OKX USDT-margined perpetual swap: post-only entries, Ioc exits, one net
 * position per contract.
 *
 * Sizes cross into contracts here and nowhere else. Above this class the desk
 * counts coins, because that is what Jev is shown and what PnL is booked in.
 */
export class OkxMarket implements VenueMarket {
  readonly coin: string;
  readonly pair: string;
  readonly label: string;
  margin = { usdc: 0 };
  account: VenueAccount | null = null;
  maxLeverage = 10;
  /** Venue fee rates, read at init. Defaults are the standard tier. */
  takerFeeBps = 5;
  makerFeeBps = 2;
  private client: OkxClient | null = null;
  private cred: OkxCredentials | null = null;
  private inst: OkxInstrument | null = null;
  private lastOrdId: string | null = null;
  private lastSide: Side | null = null;
  private lastPrice = 0;
  private lastSize = 0;
  private lastReduce = false;
  private fills = new FillPnlBook();
  private balance: BalanceRow | null = null;
  private positions: PositionRow[] = [];
  private uid: string | null = null;
  readonly fillPrints: VenueFillPrint[] = [];
  onVenueFill: ((fill: VenueFillPrint) => void) | null = null;

  get liveKey() {
    return this.client != null;
  }

  get address() {
    // The account's own id, trimmed to a stable handle. It labels the sleeve on
    // the desk and dedupes shared equity, and says nothing a key could be built from.
    return this.uid ? `okx-${this.uid.slice(-4)}` : null;
  }

  get sizeDecimals() {
    return this.inst?.sizeDecimals ?? 4;
  }

  get instrument(): OkxInstrument {
    if (!this.inst) throw new Error(`${this.label}: OKX instrument not loaded yet`);
    return this.inst;
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

  tfCloses(tf: HigherTf) {
    return this.feed.tfs.series(tf);
  }

  constructor(private feed: OkxFeed, sleeve: SleeveConfig) {
    this.coin = sleeve.coin;
    this.pair = sleeve.pair;
    this.label = sleeve.label;
    if (!config.dryRun && sleeve.okx) {
      this.cred = sleeve.okx;
      this.client = new OkxClient(sleeve.okx);
    }
  }

  /**
   * Exposure for one entry, scaled by the leverage rung Jev picked. Conviction has
   * to reach the notional to reach the PnL: the venue multiplies size by the price
   * move, never by leverage. Margin stays `quoteUsd` at every rung, since notional
   * is `quoteUsd * lev` and initial margin is notional over lev.
   */
  quoteSize(mid: number, leverage = 1): number {
    const inst = this.inst;
    if (!inst) return 0;
    const rung = Math.max(1, Math.min(this.maxLeverage, Math.floor(Number(leverage) || 1)));
    const notional = Math.min(config.quoteUsd * rung, config.maxNotionalUsd);
    const size = toLot(notional / Math.max(mid, 1e-9), inst);
    // The venue's smallest order is the floor. Under it there is nothing to send.
    return size >= inst.minSz ? size : 0;
  }

  async init() {
    // The feed reads the contract spec on connect, and it runs first.
    if (!this.feed.instrument) throw new Error(`${this.label}: feed has no OKX instrument`);
    this.inst = this.feed.instrument;
    const inst = this.inst;
    this.maxLeverage = inst.maxLeverage;
    if (this.client) {
      await this.loadAccountConfig();
      this.feed.onBalance = (row) => this.applyBalance(row);
      this.feed.onPositions = (rows) => this.applyPositions(rows);
      this.feed.onFill = (row) => this.noteFill(row);
      this.feed.onGone = (ordId) => {
        if (this.lastOrdId === ordId) this.forgetResting();
      };
      this.feed.watchUser(this.cred!);
      await this.cancelOpen();
      await this.loadFees();
    }
    await this.refresh();
    if (this.client) await this.seedFills();
    const net = config.okxDemo ? "demo" : "live";
    console.log(`okx ${this.pair} ${net} ${this.coin} tick ${inst.grid.tick} lot ${inst.lotSz} ${inst.coinsPerContract}/contract max ${this.maxLeverage}x ${this.client ? `account ${this.address}` : "DRY RUN"}`);
    if (this.client) {
      const a = this.account;
      const side = !a || !a.positionSz ? "flat" : a.positionSz > 0 ? "long" : "short";
      const size = a ? Math.abs(a.positionSz) : 0;
      const entry = a?.entryPrice != null ? ` @ ${a.entryPrice}` : "";
      console.log(`${this.label} equity $${(a?.accountValue ?? 0).toFixed(2)} available $${this.margin.usdc.toFixed(2)} ${side} ${size} ${this.coin}${entry}`);
    }
  }

  /**
   * Net mode, so one signed position answers for the contract. In long/short
   * mode every order needs a side of its own and a close is not a reduce, which
   * is a different desk from the one Jev is deciding for.
   */
  private async loadAccountConfig() {
    const rows = await this.client!.get<AccountConfigRow>("/api/v5/account/config");
    const cfg = rows[0];
    this.uid = cfg?.uid?.trim() || null;
    if (cfg?.acctLv === "1") {
      throw new Error("OKX account is in Simple mode, which cannot trade swaps. Switch it to Single-currency or Multi-currency margin.");
    }
    if (cfg?.posMode && cfg.posMode !== "net_mode") {
      try {
        await this.client!.post("/api/v5/account/set-position-mode", { posMode: "net_mode" });
      } catch (e) {
        throw new Error(`OKX account is in ${cfg.posMode}; this desk trades one net position per contract. Close open positions and set position mode to net on OKX. (${(e as Error).message})`);
      }
    }
  }

  /** Fee tier from the venue, so the cost of crossing is the real one. */
  private async loadFees() {
    try {
      const rows = await this.client!.get<FeeRow>(`/api/v5/account/trade-fee?instType=SWAP&instId=${this.instrument.id}`);
      const row = rows[0];
      // OKX states a charged rate as a negative number and a rebate as positive.
      const taker = Math.abs(Number(row?.taker));
      const maker = Math.abs(Number(row?.maker));
      if (Number.isFinite(taker) && taker > 0) this.takerFeeBps = taker * 10_000;
      if (Number.isFinite(maker) && maker > 0) this.makerFeeBps = maker * 10_000;
    } catch {
      // keep the defaults
    }
  }

  applyBalance(row: BalanceRow) {
    this.balance = row;
    this.recompute();
  }

  applyPositions(rows: PositionRow[]) {
    const mine = rows.filter((r) => r.instId === this.instrument.id);
    // A push about some other contract says nothing about this one. Only a row
    // naming this contract moves it, and `pos: "0"` is how OKX says flat.
    if (!mine.length) return;
    this.positions = mine;
    this.recompute();
  }

  private recompute() {
    this.account = this.fills.apply(
      accountFromOkx(this.balance, this.positions, this.instrument, config.okxQuoteCcy, this.account),
    );
    this.margin.usdc = this.account.withdrawable;
  }

  noteFill(row: FillRow) {
    const mapped = okxFill(row, this.instrument, this.coin);
    if (!mapped) return;
    if (!this.fills.add(mapped.pnl, this.coin)) return;
    if (this.account) this.account = this.fills.apply(this.account);
    this.fillPrints.push(mapped.print);
    if (this.feed.chart.addFill(mapped.print)) this.onVenueFill?.(mapped.print);
  }

  private async seedFills() {
    try {
      const rows = await this.client!.get<FillRow>(`/api/v5/trade/fills?instType=SWAP&instId=${this.instrument.id}&limit=100`);
      // Oldest first, so realized PnL accumulates in the order it was booked.
      for (const row of [...rows].reverse()) this.noteFill(row);
    } catch {
      // keep whatever the socket has already delivered
    }
  }

  async refresh() {
    if (!this.client) return;
    const [balance, positions] = await Promise.allSettled([
      this.client.get<BalanceRow>(`/api/v5/account/balance?ccy=${config.okxQuoteCcy}`),
      this.client.get<PositionRow>(`/api/v5/account/positions?instType=SWAP&instId=${this.instrument.id}`),
    ]);
    if (balance.status === "fulfilled" && balance.value[0]) this.balance = balance.value[0];
    if (positions.status === "fulfilled") this.positions = positions.value.filter((r) => r.instId === this.instrument.id);
    this.recompute();
  }

  readBook(): Book {
    if (!this.feed.book) throw new Error(`no OKX book yet for ${this.coin}`);
    return this.feed.book;
  }

  async setLeverage(raw: number): Promise<number> {
    const leverage = Math.max(1, Math.min(this.maxLeverage, Math.round(raw)));
    if (!this.client) return leverage;
    if (this.account?.leverage === leverage) return leverage;
    try {
      await this.client.post("/api/v5/account/set-leverage", {
        instId: this.instrument.id,
        lever: String(leverage),
        mgnMode: TD_MODE,
      });
      if (this.account) this.account.leverage = leverage;
      return leverage;
    } catch (e) {
      console.warn(`${this.label} leverage: ${(e as Error).message.slice(0, 160)}`);
      return this.account?.leverage ?? leverage;
    }
  }

  /**
   * Ask the venue what is still on the book for this contract and cancel all of
   * it. `cancelResting` only knows the id it last saw, and a partial fill drops
   * that id while the remainder rests on.
   */
  async cancelOpen(): Promise<OrderId[]> {
    if (!this.client) return [];
    try {
      const rows = await this.client.get<PendingRow>(`/api/v5/trade/orders-pending?instType=SWAP&instId=${this.instrument.id}`);
      const mine = rows.map((r) => r.ordId).filter((id): id is string => !!id);
      if (!mine.length) return [];
      await this.client.post("/api/v5/trade/cancel-batch-orders", mine.map((ordId) => ({ instId: this.instrument.id, ordId })));
      this.forgetResting();
      return mine;
    } catch {
      // next quote will replace if we still see them
      return [];
    }
  }

  /** Entries rest post-only. Exits cross as Ioc so they do not wait on a taker. */
  async send(side: Side, sizeSz: number, book: Book, cancel: OrderId[], reduceOnly = false, taker = false): Promise<Quote> {
    const inst = this.instrument;
    const size = toLot(sizeSz, inst);
    const base: QuoteBase = { side, reduceOnly, capped: false, taker };
    const contracts = orderContracts(size, inst, reduceOnly);
    if (size <= 0 || contracts <= 0) {
      return { ...base, price: 0, size: 0, txHash: null, cancel, status: "reverted", orderId: null };
    }
    const px = taker ? takerPrice(side, book, inst.grid) : this.restingPx(side, book);
    if (!this.client) {
      return { ...base, price: px, size, txHash: null, cancel, status: "sim", orderId: null };
    }
    return taker ? this.sendTaker(size, px, base) : this.sendMaker(size, px, ordIds(cancel), base);
  }

  /** Post-only price, clamped so it can never cross and get rejected. */
  private restingPx(side: Side, book: Book): number {
    let px = quotePrice(side, book, this.instrument.grid);
    if (side === "sell" && px <= book.bid) px = book.ask;
    if (side === "buy" && px >= book.ask) px = book.bid;
    return px;
  }

  private orderBody(side: Side, size: number, px: number, reduceOnly: boolean, ordType: "post_only" | "ioc") {
    const inst = this.instrument;
    return {
      instId: inst.id,
      tdMode: TD_MODE,
      side,
      ordType,
      px: formatPx(px, inst),
      sz: formatContracts(orderContracts(size, inst, reduceOnly), inst),
      reduceOnly,
    };
  }

  private async sendTaker(size: number, px: number, base: QuoteBase): Promise<Quote> {
    // The standing entry sits on the far side of an exit. Pull it before crossing.
    const open = this.lastOrdId;
    const cancel: OrderId[] = open ? [open] : [];
    if (open) {
      await this.cancelOne(open);
      this.forgetResting();
    }
    try {
      const ordId = await this.place(base.side, size, px, base.reduceOnly, "ioc");
      // An Ioc fills what the book holds and the rest is gone, but the ack does
      // not say how much. Read it back once, so an exit that found no liquidity
      // reports reverted instead of a fill that never happened.
      const done = await this.readOrder(ordId);
      if (done && done.settled && done.filledSz <= 0) {
        return { ...base, price: px, size, txHash: null, cancel, status: "reverted", orderId: null };
      }
      return {
        ...base,
        price: done?.avgPx || px,
        size: done && done.filledSz > 0 ? done.filledSz : size,
        txHash: null,
        cancel,
        status: "placed",
        orderId: ordId,
      };
    } catch (e) {
      this.warn("exit", e);
      return { ...base, price: px, size, txHash: null, cancel, status: "reverted", orderId: null };
    }
  }

  private async sendMaker(size: number, px: number, cancel: string[], base: QuoteBase): Promise<Quote> {
    const { side, reduceOnly } = base;
    if (
      this.lastOrdId &&
      this.lastSide === side &&
      this.lastPrice === px &&
      this.lastSize === size &&
      this.lastReduce === reduceOnly
    ) {
      return { ...base, price: px, size, txHash: null, cancel: [], status: "placed", orderId: this.lastOrdId, unchanged: true };
    }

    const inst = this.instrument;
    try {
      if (this.lastOrdId && this.lastSide === side && this.lastReduce === reduceOnly) {
        await this.client!.post<OrderAck>("/api/v5/trade/amend-order", {
          instId: inst.id,
          ordId: this.lastOrdId,
          newPx: formatPx(px, inst),
          newSz: formatContracts(orderContracts(size, inst, reduceOnly), inst),
        });
        this.lastPrice = px;
        this.lastSize = size;
        return { ...base, price: px, size, txHash: null, cancel: [], status: "placed", orderId: this.lastOrdId };
      }

      const open = this.lastOrdId ? [this.lastOrdId] : cancel;
      for (const ordId of open) await this.cancelOne(ordId);
      if (open.length) this.lastOrdId = null;

      const ordId = await this.place(side, size, px, reduceOnly, "post_only");
      this.lastOrdId = ordId;
      this.lastSide = side;
      this.lastPrice = px;
      this.lastSize = size;
      this.lastReduce = reduceOnly;
      return { ...base, price: px, size, txHash: null, cancel: open, status: "placed", orderId: ordId };
    } catch (e) {
      this.warn("quote", e);
      return { ...base, price: px, size, txHash: null, cancel, status: "reverted", orderId: this.lastOrdId };
    }
  }

  private async place(side: Side, size: number, px: number, reduceOnly: boolean, ordType: "post_only" | "ioc"): Promise<string> {
    const rows = await this.client!.post<OrderAck>("/api/v5/trade/order", this.orderBody(side, size, px, reduceOnly, ordType));
    const ack = rows[0];
    if (!ack?.ordId) throw new OkxError(ack?.sCode ?? "?", ack?.sMsg ?? "okx order gave no id", "/api/v5/trade/order");
    return ack.ordId;
  }

  /** What actually happened to one order, in coins. Null when the read failed. */
  private async readOrder(ordId: string): Promise<{ avgPx: number; filledSz: number; settled: boolean } | null> {
    try {
      const rows = await this.client!.get<OrderRow>(`/api/v5/trade/order?instId=${this.instrument.id}&ordId=${ordId}`);
      const row = rows[0];
      if (!row) return null;
      const avgPx = Number(row.avgPx);
      const filled = Number(row.accFillSz);
      return {
        avgPx: Number.isFinite(avgPx) && avgPx > 0 ? avgPx : 0,
        filledSz: Number.isFinite(filled) && filled > 0 ? toBase(filled, this.instrument) : 0,
        settled: row.state === "filled" || row.state === "canceled",
      };
    } catch {
      // The fill still arrives on the order stream. Report what was sent.
      return null;
    }
  }

  private async cancelOne(ordId: string) {
    await this.client!.post("/api/v5/trade/cancel-order", { instId: this.instrument.id, ordId }).catch(() => {});
  }

  /** Pull the standing quote. A resting order Jev no longer wants still gets hit. */
  async cancelResting(): Promise<OrderId[]> {
    const ordId = this.lastOrdId;
    if (!this.client || !ordId) return [];
    await this.cancelOne(ordId);
    this.forgetResting();
    return [ordId];
  }

  private forgetResting() {
    this.lastOrdId = null;
    this.lastSide = null;
    this.lastPrice = 0;
    this.lastSize = 0;
    this.lastReduce = false;
  }

  private warn(what: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isRateLimited(e)) console.warn(`${this.label}: okx rate limited; ${what} skipped`);
    else console.warn(`${this.label} ${what}: ${msg.slice(0, 180)}`);
  }
}

/** OKX order handles are strings. Anything else came from a sim fill. */
function ordIds(ids: OrderId[]): string[] {
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}
