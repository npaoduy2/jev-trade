import { config } from "../config";
import type { Book } from "../types";
import type { FillPnlLike } from "../account";
import { fillDir, type ClearinghouseLike, type SpotStateLike } from "./account";
import { bookFromLevels } from "../book";
import { CHART_INTERVAL, CHART_LOOKBACK_MS, MAX_MINUTE_BARS, MINUTE_MS, VenueChart } from "../chart";
import { parseAssetCtx, type AssetCtx } from "../indicators";
import { sameCoin } from "../sleeves";
import { BAR_MS, Timeframes, type HigherTf } from "../timeframes";
import { TradeFeed } from "../trades";
import type { VenueFeed } from "../venue";
import { candles, info, WS_URL } from "./rest";

/**
 * Local Hyperliquid book + tape over the official WS, with an HTTP snapshot so startup
 * does not wait on the socket. Ticks fire at `tickMs` once a book exists.
 */
export class HlFeed implements VenueFeed {
  readonly trades = new TradeFeed();
  readonly chart = new VenueChart();
  readonly tfs = new Timeframes((tf, bars, now) => this.pullCloses(tf, bars, now));
  assetCtx: AssetCtx | null = null;
  book: Book | null = null;
  tick = 0;
  onGone: ((oid: number) => void) | null = null;
  onClearinghouse: ((state: ClearinghouseLike) => void) | null = null;
  onSpotState: ((state: SpotStateLike) => void) | null = null;
  onUserPnl: ((fill: FillPnlLike) => void) | null = null;
  private lastTickAt = 0;
  private lastPriceAt = 0;
  private lastPriceMid = Number.NaN;
  private onTick: ((tick: number) => void) | null = null;
  onPrice: ((book: Book) => void) | null = null;
  private user: `0x${string}` | null = null;
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private seenTids = new Set<number>();

  constructor(readonly coin: string) {}

  async connect(): Promise<void> {
    await this.snapshot();
    await this.loadCandles().catch((e) => {
      console.warn(`${this.coin} candles: ${(e as Error).message.slice(0, 160)}`);
    });
    // Higher intervals come over REST. Block once so the first tick sees them.
    await this.tfs.refresh(this.coin);
    this.pollAssetCtx().catch(() => {});
    this.openSocket();
    setInterval(() => this.maybeTick(), config.tickMs);
    setInterval(() => { if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.snapshot().catch(() => {}); }, 2_000);
    setInterval(() => this.pollTrades().catch(() => {}), 2_000);
    setInterval(() => this.pollAssetCtx().catch(() => {}), 15_000);
    setInterval(() => this.tfs.refresh(this.coin).catch(() => {}), 60_000);
    this.pollTrades().catch(() => {});
  }

  watchUser(user: `0x${string}`) {
    this.user = user;
    this.subscribeUser();
  }

  start(onTick: (tick: number) => void) {
    this.onTick = onTick;
    this.maybePrice();
    this.maybeTick();
  }

  /** Seed the chart once. The candle socket carries it from there. */
  private async loadCandles(now = Date.now()) {
    const [m15, m1] = await Promise.all([
      candles(this.coin, "15m", now - CHART_LOOKBACK_MS, now),
      candles(this.coin, "1m", now - MAX_MINUTE_BARS * MINUTE_MS, now),
    ]);
    this.chart.seed(m15, "15m");
    this.chart.seed(m1, "1m");
  }

  private async pullCloses(tf: HigherTf, bars: number, now: number): Promise<number[]> {
    const rows = await candles(this.coin, tf, now - bars * BAR_MS[tf], now);
    return rows.map((r) => r.close);
  }

  private async snapshot() {
    const data = await info<{ levels?: [{ px: string; sz: string }[], { px: string; sz: string }[]] }>({
      type: "l2Book",
      coin: this.coin,
    });
    if (!data.levels) return;
    const next = bookFromLevels(this.tick, data.levels[0] ?? [], data.levels[1] ?? []);
    if (next) this.book = next;
  }

  private openSocket(delay = 0) {
    setTimeout(() => {
      const ws = new WebSocket(WS_URL());
      this.ws = ws;
      ws.onopen = () => {
        this.send({ method: "subscribe", subscription: { type: "l2Book", coin: this.coin, fast: true } });
        this.send({ method: "subscribe", subscription: { type: "trades", coin: this.coin } });
        this.send({ method: "subscribe", subscription: { type: "candle", coin: this.coin, interval: CHART_INTERVAL } });
        this.send({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: this.coin } });
        this.subscribeUser();
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => this.send({ method: "ping" }), 20_000);
      };
      ws.onmessage = (e) => this.onMessage(String(e.data));
      ws.onclose = () => {
        if (this.ping) clearInterval(this.ping);
        this.ping = null;
        this.openSocket(Math.min(delay + 500, 8_000));
      };
      ws.onerror = () => ws.close();
    }, delay);
  }

  private subscribeUser() {
    if (!this.user || this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ method: "subscribe", subscription: { type: "userFills", user: this.user } });
    this.send({ method: "subscribe", subscription: { type: "orderUpdates", user: this.user } });
    this.send({ method: "subscribe", subscription: { type: "clearinghouseState", user: this.user } });
    this.send({ method: "subscribe", subscription: { type: "spotState", user: this.user } });
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: string) {
    let m: { channel?: string; data?: any };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.channel === "l2Book" && m.data?.levels) {
      const next = bookFromLevels(this.tick, m.data.levels[0] ?? [], m.data.levels[1] ?? []);
      if (next) {
        this.book = next;
        this.maybePrice();
        this.maybeTick();
      }
      return;
    }
    if (m.channel === "trades") {
      const prints = Array.isArray(m.data) ? m.data : m.data ? [m.data] : [];
      for (const t of prints) this.ingestPrint(t);
      return;
    }
    if (m.channel === "candle") {
      const rows = Array.isArray(m.data) ? m.data : m.data ? [m.data] : [];
      for (const c of rows) this.chart.upsertCandle(c);
      return;
    }
    if (m.channel === "activeAssetCtx" && m.data) {
      const coin = m.data.coin ?? m.data.ctx?.coin;
      if (coin && !sameCoin(coin, this.coin)) return;
      this.assetCtx = parseAssetCtx(m.data.ctx ?? m.data);
      return;
    }
    if (m.channel === "userFills" && m.data) {
      for (const f of m.data.fills ?? []) {
        if (!sameCoin(f.coin, this.coin)) continue;
        this.onUserPnl?.(f);
        if (m.data.isSnapshot) continue;
        this.trades.pushFill({
          block: this.tick,
          txHash: f.hash,
          orderId: f.oid,
          price: Number(f.px),
          size: Number(f.sz),
          updatedSize: -1,
          side: f.side === "B" ? "buy" : "sell",
          feeUsd: Number(f.fee) || 0,
          closedPnl: Number.isFinite(Number(f.closedPnl)) ? Number(f.closedPnl) : undefined,
          dir: fillDir(f.dir),
        });
      }
      return;
    }
    if (m.channel === "clearinghouseState" && m.data) {
      const state = m.data.clearinghouseState ?? m.data;
      if (state?.assetPositions || state?.marginSummary) this.onClearinghouse?.(state);
      return;
    }
    if (m.channel === "spotState" && m.data) {
      const state = m.data.spotState ?? m.data;
      if (state?.balances) this.onSpotState?.(state);
      return;
    }
    if (m.channel === "orderUpdates" && Array.isArray(m.data)) {
      for (const u of m.data) {
        if (!sameCoin(u.order?.coin, this.coin)) continue;
        if (u.status === "filled" || u.status === "canceled" || u.status === "rejected") this.onGone?.(u.order.oid);
      }
    }
  }

  private async pollAssetCtx() {
    const pair = await info<[{ universe?: { name?: string }[] }, unknown[]]>({ type: "metaAndAssetCtxs" });
    if (!Array.isArray(pair) || pair.length < 2) return;
    const uni = pair[0]?.universe;
    const ctxs = pair[1];
    if (!Array.isArray(uni) || !Array.isArray(ctxs)) return;
    const i = uni.findIndex((u) => u.name === this.coin);
    if (i >= 0) this.assetCtx = parseAssetCtx(ctxs[i]);
  }

  private async pollTrades() {
    const prints = await info<{ px: string; sz: string; side: string; tid?: number }[]>({
      type: "recentTrades",
      coin: this.coin,
    });
    if (!Array.isArray(prints)) return;
    for (const t of prints) this.ingestPrint(t);
  }

  private ingestPrint(t: { px?: string; sz?: string; side?: string; tid?: number }) {
    const tid = t.tid;
    if (tid != null) {
      if (this.seenTids.has(tid)) return;
      this.seenTids.add(tid);
      if (this.seenTids.size > 4000) {
        const first = this.seenTids.values().next().value;
        if (first != null) this.seenTids.delete(first);
      }
    }
    this.trades.pushPrint({
      price: Number(t.px),
      size: Number(t.sz),
      side: t.side === "B" ? "buy" : "sell",
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
