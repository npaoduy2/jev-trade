import { config, type OkxCredentials } from "../config";
import { bookFromLevels } from "../book";
import { CHART_LOOKBACK_MS, VenueChart } from "../chart";
import { parseAssetCtx, type AssetCtx } from "../indicators";
import { Timeframes } from "../timeframes";
import { TradeFeed } from "../trades";
import type { Book } from "../types";
import type { VenueFeed } from "../venue";
import type { BalanceRow, FillRow, PositionRow } from "./account";
import { pullCandles, pullCloses } from "./candles";
import { assetCtxFromOkx, type FundingRow, type IndexRow, type MarkRow, type OpenInterestRow, type TickerRow } from "./context";
import { DepthBook, type RawLevel } from "./depth";
import { loadInstrument, type OkxInstrument } from "./instrument";
import { publicGet, WS_BUSINESS, WS_PRIVATE, WS_PUBLIC, wsLogin } from "./rest";

/** Deep enough for the 50bps depth bands, shallow enough to stay one page. */
const BOOK_DEPTH = 400;
const MINUTE_BARS = 500;
const HIGHER_15M_BARS = Math.ceil(CHART_LOOKBACK_MS / (15 * 60_000));

type Socket = "public" | "business" | "private";

/**
 * Local OKX book, tape and candles over the v5 sockets, with REST snapshots so
 * startup does not wait on them. Ticks fire at `tickMs` once a book exists.
 *
 * Three sockets, because OKX splits them: `public` carries depth and prints,
 * `business` carries candles, and `private` carries this account's balance,
 * position and order updates once it has logged in.
 */
export class OkxFeed implements VenueFeed {
  readonly trades = new TradeFeed();
  readonly chart = new VenueChart();
  readonly tfs = new Timeframes((tf, bars) => pullCloses(this.instId, tf, bars));
  assetCtx: AssetCtx | null = null;
  book: Book | null = null;
  tick = 0;
  instrument: OkxInstrument | null = null;
  onGone: ((ordId: string) => void) | null = null;
  onBalance: ((row: BalanceRow) => void) | null = null;
  onPositions: ((rows: PositionRow[]) => void) | null = null;
  onFill: ((row: FillRow) => void) | null = null;
  onPrice: ((book: Book) => void) | null = null;
  private depth = new DepthBook();
  private lastTickAt = 0;
  private lastPriceAt = 0;
  private lastPriceMid = Number.NaN;
  private onTick: ((tick: number) => void) | null = null;
  private sockets = new Map<Socket, WebSocket>();
  private pings = new Map<Socket, ReturnType<typeof setInterval>>();
  private cred: OkxCredentials | null = null;
  private seenTrades = new Set<string>();
  private resyncing = false;

  constructor(readonly coin: string, readonly instId: string) {}

  private get perContract(): number {
    return this.instrument?.coinsPerContract ?? 1;
  }

  async connect(): Promise<void> {
    this.instrument = await loadInstrument(this.instId, this.coin);
    await this.snapshot();
    await this.loadCandles().catch((e) => {
      console.warn(`${this.coin} candles: ${(e as Error).message.slice(0, 160)}`);
    });
    // Higher intervals come over REST. Block once so the first tick sees them.
    await this.tfs.refresh(this.coin);
    await this.pollAssetCtx().catch(() => {});
    this.open("public", WS_PUBLIC());
    this.open("business", WS_BUSINESS());
    setInterval(() => this.maybeTick(), config.tickMs);
    // Only until the socket sends its own snapshot, which then owns the chain.
    setInterval(() => { if (!this.depth.ready && !this.resyncing) this.snapshot().catch(() => {}); }, 2_000);
    setInterval(() => this.pollTrades().catch(() => {}), 2_000);
    setInterval(() => this.pollAssetCtx().catch(() => {}), 15_000);
    setInterval(() => this.tfs.refresh(this.coin).catch(() => {}), 60_000);
    this.pollTrades().catch(() => {});
  }

  /** Log the private socket in. Balance, position and fills arrive on it. */
  watchUser(cred: OkxCredentials) {
    this.cred = cred;
    this.open("private", WS_PRIVATE());
  }

  start(onTick: (tick: number) => void) {
    this.onTick = onTick;
    this.maybePrice();
    this.maybeTick();
  }

  private async loadCandles() {
    const [m15, m1] = await Promise.all([
      pullCandles(this.instId, "15m", HIGHER_15M_BARS),
      pullCandles(this.instId, "1m", MINUTE_BARS),
    ]);
    this.chart.seed(m15, "15m");
    this.chart.seed(m1, "1m");
  }

  private async snapshot() {
    const rows = await publicGet<{ bids?: RawLevel[]; asks?: RawLevel[]; seqId?: number }>(
      `/api/v5/market/books?instId=${this.instId}&sz=${BOOK_DEPTH}`,
    );
    const top = rows[0];
    if (!top) return;
    this.depth.snapshot(top.bids ?? [], top.asks ?? [], Number(top.seqId ?? -1));
    this.rebuild();
  }

/**
   * Re-seed after a broken sequence. Asking the socket again is the only way
   * back: a REST snapshot carries a `seqId` from its own moment, so the next
   * delta would break the chain against it too and never stop asking.
   */
  private resyncBooks() {
    if (this.resyncing) return;
    this.resyncing = true;
    this.depth.reset();
    const arg = { channel: "books", instId: this.instId };
    this.send("public", { op: "unsubscribe", args: [arg] });
    this.send("public", { op: "subscribe", args: [arg] });
    // A backstop, in case the fresh snapshot never lands.
    setTimeout(() => { this.resyncing = false; }, 5_000);
  }

  private rebuild() {
    const { bids, asks } = this.depth.levels(this.perContract, BOOK_DEPTH);
    const next = bookFromLevels(this.tick, bids, asks);
    if (!next) return;
    this.book = next;
    this.maybePrice();
    this.maybeTick();
  }

  private open(kind: Socket, url: string, delay = 0) {
    setTimeout(() => {
      const ws = new WebSocket(url);
      this.sockets.set(kind, ws);
      ws.onopen = () => {
        if (kind === "private") {
          if (this.cred) ws.send(JSON.stringify(wsLogin(this.cred)));
        } else {
          this.subscribe(kind);
        }
        const ping = this.pings.get(kind);
        if (ping) clearInterval(ping);
        // OKX drops a socket idle for 30s, and wants the bare string.
        this.pings.set(kind, setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send("ping"); }, 20_000));
      };
      ws.onmessage = (e) => this.onMessage(kind, String(e.data));
      ws.onclose = () => {
        const ping = this.pings.get(kind);
        if (ping) clearInterval(ping);
        this.pings.delete(kind);
        if (kind === "public") this.depth.reset();
        this.open(kind, url, Math.min(delay + 500, 8_000));
      };
      ws.onerror = () => ws.close();
    }, delay);
  }

  private subscribe(kind: Socket) {
    const instId = this.instId;
    if (kind === "public") {
      this.send(kind, { op: "subscribe", args: [{ channel: "books", instId }, { channel: "trades", instId }] });
      return;
    }
    if (kind === "business") {
      this.send(kind, { op: "subscribe", args: [{ channel: "candle1m", instId }] });
      return;
    }
    this.send(kind, {
      op: "subscribe",
      args: [
        { channel: "account" },
        { channel: "positions", instType: "SWAP", instId },
        { channel: "orders", instType: "SWAP", instId },
      ],
    });
  }

  private send(kind: Socket, msg: unknown) {
    const ws = this.sockets.get(kind);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private onMessage(kind: Socket, raw: string) {
    if (raw === "pong") return;
    let m: { event?: string; code?: string; msg?: string; arg?: { channel?: string }; action?: string; data?: any };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.event === "login") {
      if (m.code === "0") {
        this.subscribe("private");
      } else {
        console.warn(`${this.coin} okx login: ${m.msg ?? m.code}`);
      }
      return;
    }
    if (m.event === "error") {
      console.warn(`${this.coin} okx ${kind}: ${m.msg ?? ""} (${m.code ?? "?"})`.trim());
      return;
    }
    if (m.event) return;
    const channel = m.arg?.channel;
    const rows: any[] = Array.isArray(m.data) ? m.data : m.data ? [m.data] : [];
    if (!channel || !rows.length) return;

    if (channel === "books") {
      const top = rows[0];
      const seqId = Number(top.seqId ?? -1);
      const prevSeqId = Number(top.prevSeqId ?? -1);
      if (m.action === "snapshot") {
        this.depth.snapshot(top.bids ?? [], top.asks ?? [], seqId);
        this.resyncing = false;
      } else if (!this.depth.update(top.bids ?? [], top.asks ?? [], seqId, prevSeqId)) {
        // A lost message leaves a book that no longer matches the venue's.
        this.resyncBooks();
        return;
      }
      this.rebuild();
      return;
    }
    if (channel === "trades") {
      for (const t of rows) this.ingestPrint(t);
      return;
    }
    if (channel === "candle1m") {
      for (const row of rows) {
        const c = Array.isArray(row) ? row : null;
        if (c) this.chart.upsertCandle({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4] }, "1m");
      }
      return;
    }
    if (channel === "account") {
      this.onBalance?.(rows[0] as BalanceRow);
      return;
    }
    if (channel === "positions") {
      this.onPositions?.(rows as PositionRow[]);
      return;
    }
    if (channel === "orders") {
      for (const o of rows) {
        if (o?.instId !== this.instId) continue;
        if (o.tradeId && Number(o.fillSz) > 0) this.onFill?.(o as FillRow);
        const state = o.state;
        if (state === "filled" || state === "canceled" || state === "mmp_canceled") this.onGone?.(String(o.ordId));
      }
    }
  }

  private async pollAssetCtx() {
    const index = this.instId.replace(/-SWAP$/, "");
    const [ticker, mark, funding, oi, idx] = await Promise.allSettled([
      publicGet<TickerRow>(`/api/v5/market/ticker?instId=${this.instId}`),
      publicGet<MarkRow>(`/api/v5/public/mark-price?instType=SWAP&instId=${this.instId}`),
      publicGet<FundingRow>(`/api/v5/public/funding-rate?instId=${this.instId}`),
      publicGet<OpenInterestRow>(`/api/v5/public/open-interest?instType=SWAP&instId=${this.instId}`),
      publicGet<IndexRow>(`/api/v5/market/index-tickers?instId=${index}`),
    ]);
    const first = <T>(r: PromiseSettledResult<T[]>): T | null =>
      r.status === "fulfilled" ? r.value[0] ?? null : null;
    this.assetCtx = parseAssetCtx(
      assetCtxFromOkx({
        ticker: first(ticker),
        mark: first(mark),
        funding: first(funding),
        openInterest: first(oi),
        index: first(idx),
      }),
    );
  }

  private async pollTrades() {
    const prints = await publicGet<{ px?: string; sz?: string; side?: string; tradeId?: string }>(
      `/api/v5/market/trades?instId=${this.instId}&limit=100`,
    );
    for (const t of prints) this.ingestPrint(t);
  }

  private ingestPrint(t: { px?: string; sz?: string; side?: string; tradeId?: string }) {
    const tid = t.tradeId;
    if (tid) {
      if (this.seenTrades.has(tid)) return;
      this.seenTrades.add(tid);
      if (this.seenTrades.size > 4000) {
        const first = this.seenTrades.values().next().value;
        if (first != null) this.seenTrades.delete(first);
      }
    }
    this.trades.pushPrint({
      price: Number(t.px),
      // OKX prints a swap tape in contracts. The desk counts flow in coins.
      size: Number(t.sz) * this.perContract,
      side: t.side === "buy" ? "buy" : "sell",
    });
  }

  private maybePrice() {
    if (!this.book) return;
    const now = Date.now();
    this.chart.addMid(this.book.mid, now);
    if (!this.onPrice) return;
    if (now - this.lastPriceAt < config.priceMs) return;
    if (this.book.mid === this.lastPriceMid) return;
    this.lastPriceAt = now;
    this.lastPriceMid = this.book.mid;
    this.onPrice(this.book);
  }

  private maybeTick() {
    if (!this.book || !this.onTick) return;
    const now = Date.now();
    if (now - this.lastTickAt < config.tickMs) return;
    this.lastTickAt = now;
    this.tick++;
    this.trades.setTick(this.tick);
    this.book = { ...this.book, block: this.tick };
    this.onTick(this.tick);
  }
}
