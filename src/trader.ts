import { config } from "./config";
import { bpsBetween, snapshotIndicators, venueFeatures } from "./indicators";
import { completedTrips, openedAt, replayGain } from "./history";
import { HIGHER_TFS } from "./timeframes";
import { isVenueOrderId, type VenueFillPrint, type VenueMarket } from "./venue";
import { jevQuestions, marketFacing, type Model, type ModelDecision, type TradeState } from "./model";
import { leverageRungs, planQuote, type QuotePlan } from "./plan";
import { aggregateFills, emptySummary, takeLiveFills, takeSimFills, type FlowWindow, type Resting, type TradeFeed } from "./trades";
import type { BlockEvent, Book, Fill, OrderId, PricePoint, Quote, Side, Timing, Totals } from "./types";

const emptyTotals = (): Totals => ({
  blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0,
  jevUsd: 0, gasSz: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlSz: 0, pnlPct: 0,
});

const JEV_PAUSE_MS = 30_000;
/** How stale the venue snapshot may get before a tick waits on a fresh one. */
const REFRESH_MS = 10_000;
/** How much of a position's gain history rides along. Bounds the payload. */
const PATH_SAMPLES = 30;
/** Window Jev is shown its own recent trading over. */
const RECENT_TICKS = 30;

export function jevUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /402\b|no available TypeSafe API credits|insufficient credits/i.test(msg);
}

/**
 * Every tick: read the book and ask the model. A tick is late only when Jev
 * is still answering. Hyperliquid leverage/order I/O runs in the background
 * so a fill or quote does not stall the next decision.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  /** Exactly what went to Jev last tick: the state it read and the questions asked. */
  lastAsk: { at: number; tick: number; state: unknown; questions: unknown } | null = null;
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  private trades: TradeFeed | null = null;
  private orders = new Map<OrderId, Resting>();
  private simId = 0;
  private sendSeq = 0;
  private exchangeTail: Promise<void> = Promise.resolve();
  private position = { sz: 0, costUsd: 0 };
  private totals: Totals = emptyTotals();
  private jevPauseUntil = 0;
  private lastOi: number | null = null;
  private refreshedAt = 0;
  /** The entry Jev asked for, kept until it is filled, closed, or stood down. */
  private entry: { side: Side; target: number } | null = null;
  /** Where the open position has been. Reset the moment it goes flat. */
  private track: { openedAt: number; peak: number; peakAt: number; path: number[]; notionalUsd: number } | null = null;
  /** Round trips this desk has closed, and the running fee total per tick. */
  private trips: { closedAt: number; heldTicks: number; notionalUsd: number }[] = [];
  private feeTrail: { block: number; usd: number }[] = [];

  constructor(
    private market: VenueMarket,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
  ) {}

  get tape(): PricePoint[] {
    return this.market.chartPoints;
  }

  attachTradeFeed(feed: TradeFeed) {
    this.trades = feed;
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    if (this.busy) {
      this.markLate(block, this.lastBook);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = this.market.readBook();
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.harvest();

      // Refresh before reading, so the position, unrealized, and liquidation that
      // Jev and the desk both see belong to this tick. Counting ticks instead of
      // elapsed time made this every 10s at a 2s tick and every 5min at a 60s one.
      if (Date.now() - this.refreshedAt >= REFRESH_MS) {
        this.refreshedAt = Date.now();
        await this.market.refresh().catch(() => {});
      }
      this.syncFromVenue();
      const timing = { readMs: Math.round(readMs), loopMs: 0 };
      if (Date.now() < this.jevPauseUntil) {
        this.markLate(block, book);
        return;
      }
      try {
        const asked = this.buildState(block, book);
        this.lastAsk = { at: Date.now(), tick: block, state: marketFacing(asked), questions: jevQuestions(asked) };
        const decision = await this.model.decide(asked);
        this.totals.decisions++;
        this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;
        const plan = planQuote({
          intent: decision.intent,
          bias: decision.bias,
          positionSz: this.position.sz,
          quoteSz: this.market.quoteSize(book.mid, decision.leverage),
          exitStyle: decision.exitStyle,
        });
        timing.loopMs = Math.round(performance.now() - t0);
        this.emit(block, book, decision, null, false, timing);
        if (plan) this.enqueueQuote(block, decision, plan, book);
        // A maker entry fills in pieces. Once any of it lands, the next tick asks
        // whether to keep the position, and pulling the rest on that answer would
        // strand Jev at a fraction of the size it asked for.
        else if (this.entryWorking()) this.enqueueEntryRefresh(block);
        else this.enqueueStandDown();
      } catch (e) {
        const msg = (e as Error).message;
        if (jevUnavailable(e)) {
          this.jevPauseUntil = Date.now() + JEV_PAUSE_MS;
          console.error(`jev paused ${JEV_PAUSE_MS / 1000}s: ${msg}`);
        } else {
          console.error(`tick ${block}:`, msg);
        }
        this.markLate(block, book, timing);
      }
    } catch (e) {
      console.error(`tick ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** True while a partly filled entry still has size to work, on its own side. */
  private entryWorking(): boolean {
    const e = this.entry;
    if (!e) return false;
    const filled = e.side === "buy" ? this.position.sz : -this.position.sz;
    return filled > 1e-9 && filled < e.target - 1e-9;
  }

  private enqueueQuote(block: number, decision: ModelDecision, plan: QuotePlan, book: Book) {
    this.entry = plan.reduceOnly ? null : { side: plan.side, target: plan.size };
    const seq = ++this.sendSeq;
    this.exchangeTail = this.exchangeTail.catch(() => {}).then(async () => {
      if (seq !== this.sendSeq) return;
      // An exit skips the leverage write whichever way it leaves: nothing about
      // it depends on margin, and the extra call is delay on the order that has
      // to land. Keying this off `taker` missed a resting exit.
      if (!plan.reduceOnly) {
        await this.market.setLeverage(decision.leverage);
        if (seq !== this.sendSeq) return;
      }
      const cancel = [...this.orders.keys()].filter(isVenueOrderId);
      // Price against the touch as it is now, not as it was before Jev answered.
      // A post-only order priced off a book that aged through the decision and
      // the leverage write gets rejected for crossing.
      let live = book;
      try {
        live = this.market.readBook();
      } catch {
        // No fresher book than the one this tick started with.
      }
      const quote = await this.market.send(plan.side, plan.size, live, cancel, plan.reduceOnly, plan.taker);
      if (seq !== this.sendSeq) return;
      this.applyPosted(block, quote);
    });
  }

  /**
   * Re-price the unfilled part of an entry at the touch it would be placed at
   * now. Leaving it alone let an order rest at a price sixteen ticks old and
   * fill on a view Jev had long since re-taken. `send` modifies in place when
   * the price moved and does nothing at all when it did not.
   */
  private enqueueEntryRefresh(block: number) {
    const e = this.entry;
    if (!e) return;
    const filled = e.side === "buy" ? this.position.sz : -this.position.sz;
    const left = e.target - filled;
    if (left <= 0) return;
    const seq = ++this.sendSeq;
    this.exchangeTail = this.exchangeTail.catch(() => {}).then(async () => {
      if (seq !== this.sendSeq) return;
      let live: Book;
      try {
        live = this.market.readBook();
      } catch {
        return;
      }
      const cancel = [...this.orders.keys()].filter(isVenueOrderId);
      const quote = await this.market.send(e.side, left, live, cancel, false, false);
      if (seq !== this.sendSeq) return;
      this.applyPosted(block, quote);
    });
  }

  /** Jev held. Pull the standing quote so an order it no longer wants cannot get hit. */
  private enqueueStandDown() {
    this.entry = null;
    const seq = ++this.sendSeq;
    this.exchangeTail = this.exchangeTail.catch(() => {}).then(async () => {
      if (seq !== this.sendSeq) return;
      await this.market.cancelResting();
      if (seq !== this.sendSeq) return;
      this.orders.clear();
    });
  }

  private markLate(block: number, book: Book | null, timing?: Timing) {
    this.totals.lateBlocks++;
    if (book) this.emit(block, book, null, null, true, timing);
  }

  private applyPosted(block: number, quote: Quote) {
    const e = this.history.find((h) => h.block === block);
    if (e) e.quote = quote;
    if (!quote.unchanged) this.totals.quotes++;
    if (quote.status === "reverted") this.totals.reverted++;
    if (quote.taker) {
      // An Ioc never rests. Live fills arrive on userFills; a dry run fills here.
      this.orders.clear();
      if (quote.status === "sim") this.simTakerFill(block, quote);
    } else if (quote.status === "sim") {
      this.orders.clear();
      this.orders.set(--this.simId, { side: quote.side, price: quote.price, size: quote.size, block });
    } else if (quote.status === "placed" && quote.orderId != null) {
      this.orders.clear();
      this.orders.set(quote.orderId, { side: quote.side, price: quote.price, size: quote.size, block });
    }
    this.onQuote(block, quote);
  }

  /** A dry-run exit crosses the touch, so it fills now rather than waiting on a print. */
  private simTakerFill(block: number, quote: Quote) {
    const fill: Fill = {
      side: quote.side,
      size: quote.size,
      price: quote.price,
      txHash: null,
      orderId: --this.simId,
      simulated: true,
      dir: quote.reduceOnly ? "close" : "open",
    };
    this.applyFill(fill);
    this.recordFill(block, fill);
  }

  private harvest() {
    if (!this.trades) return;
    const prints = this.trades.drainPrints();
    const fills = this.market.liveKey ? takeLiveFills(this.orders, this.trades.drainFills()) : takeSimFills(this.orders, prints);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      this.applyFill(f);
      byBlock.set(f.block, [...(byBlock.get(f.block) ?? []), f]);
    }
    for (const [block, fs] of byBlock) this.recordFill(block, aggregateFills(fs));
    this.market.refresh().catch(() => {});
  }

  private recordFill(block: number, fill: Fill) {
    const e = this.history.find((h) => h.block === block);
    if (e) e.fill = fill;
    this.onFill(block, fill);
  }

  private restingSz(side: Side) {
    let sz = 0;
    for (const o of this.orders.values()) if (o.side === side) sz += o.size;
    return sz;
  }

  /** Jev's newest answers. Late ticks can push this further back than one tick. */
  private lastAnswer(): TradeState["lastTick"] {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const d = this.history[i]!.decision;
      if (d && !d.late && d.trend && d.intent && d.bias && d.leverage != null) {
        return { trend: d.trend, intent: d.intent, bias: d.bias, leverage: d.leverage };
      }
    }
    return null;
  }

  /**
   * Rebuild from the venue what this process never saw. A restart otherwise
   * hands Jev a position with no peak, no path and no record of how often it
   * has been going around, which are the numbers that argue against closing a
   * winner early.
   */
  restore(opts: {
    nowMs: number;
    fills: VenueFillPrint[];
    positionSz: number;
    entryPrice: number | null;
    closes: number[];
  }) {
    const firstBlock = 1;
    const ticksOf = (ms: number) => Math.max(0, Math.round(ms / config.tickMs));
    this.trips = completedTrips(opts.fills)
      .slice(-50)
      .map((t) => ({
        closedAt: firstBlock - ticksOf(opts.nowMs - t.closedAt),
        heldTicks: Math.max(1, ticksOf(t.heldMs)),
        notionalUsd: t.notionalUsd,
      }));

    this.track = null;
    const since = openedAt(opts.fills);
    if (since == null || !opts.positionSz || !opts.entryPrice) return;
    const bars = Math.max(1, Math.round((opts.nowMs - since) / 60_000));
    const g = replayGain(opts.closes.slice(-bars), opts.entryPrice, opts.positionSz < 0);
    if (!g) return;
    const barsAgo = g.path.length - 1 - g.peakIdx;
    this.track = {
      openedAt: firstBlock - ticksOf(opts.nowMs - since) + 1,
      peak: g.peak,
      peakAt: firstBlock - ticksOf(barsAgo * 60_000),
      path: g.path.slice(-PATH_SAMPLES),
      notionalUsd: Math.abs(opts.positionSz) * opts.entryPrice,
    };
  }

  /**
   * Follow the open position's gain across ticks. A position at -5bps that
   * peaked at +45 and one that never cleared +2 read the same from unrealized
   * alone, and they are not the same position.
   */
  private trackPath(block: number, gainBps: number | null, notionalUsd = 0) {
    if (gainBps == null) {
      if (this.track) {
        this.trips.push({ closedAt: block, heldTicks: block - this.track.openedAt + 1, notionalUsd: this.track.notionalUsd });
        if (this.trips.length > 50) this.trips.shift();
      }
      this.track = null;
      return;
    }
    if (!this.track) this.track = { openedAt: block, peak: gainBps, peakAt: block, path: [], notionalUsd };
    if (notionalUsd > this.track.notionalUsd) this.track.notionalUsd = notionalUsd;
    if (gainBps > this.track.peak) {
      this.track.peak = gainBps;
      this.track.peakAt = block;
    }
    this.track.path.push(round(gainBps, 1));
    if (this.track.path.length > PATH_SAMPLES) this.track.path.shift();
  }

  /**
   * What this desk has been doing lately, in its own terms. Cost is charged per
   * round trip, not per decision, so how often it goes around is the number
   * that matters and nothing in the state carried it.
   */
  private recentTrading(block: number): TradeState["recent"] {
    const since = block - RECENT_TICKS;
    const trips = this.trips.filter((t) => t.closedAt > since);
    const held = this.trips.slice(-10).map((t) => t.heldTicks).sort((a, b) => a - b);
    const old = this.feeTrail.find((f) => f.block > since) ?? this.feeTrail[0];
    // In bps of what was actually traded, so it sits beside peakBps and the
    // moves rather than leaking how big this account is.
    const spent = old ? this.totals.gasUsd - old.usd : 0;
    const traded = trips.reduce((s, t) => s + t.notionalUsd, 0);
    return {
      windowTicks: RECENT_TICKS,
      trips: trips.length,
      holdTicksMedian: held.length ? held[Math.floor(held.length / 2)]! : null,
      costBps: traded > 0 ? round((spent / traded) * 10_000, 2) : null,
    };
  }

  private buildState(block: number, book: Book): TradeState {
    this.syncFromVenue();
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0);
    const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    const posSz = this.position.sz;
    const a = this.market.account;
    const entry = this.entryPrice();
    const unrealized = a ? a.unrealizedUsd : this.unrealizedUsd(book.mid);
    const mtf: TradeState["mtf"] = { "1m": snapNums(snapshotIndicators(this.market.candleCloses(500), book.mid)) };
    for (const tf of HIGHER_TFS) mtf[tf] = snapNums(snapshotIndicators(this.market.tfCloses(tf), book.mid));
    const asset = snapNums(venueFeatures(this.market.assetCtx, book.mid));
    const oiNow = asset.openInterest;
    const oiChangeBps = this.lastOi != null && oiNow != null ? bpsBetween(this.lastOi, oiNow) : null;
    if (oiNow != null) this.lastOi = oiNow;
    const sizing: TradeState["sizing"] = {};
    for (const rung of leverageRungs(this.market.maxLeverage)) {
      sizing[String(rung)] = round(this.market.quoteSize(book.mid, rung) * book.mid, 2);
    }
    const liqPx = a?.liquidationPx ?? null;
    const liqDist = liqPx != null ? Math.abs(bpsBetween(book.mid, liqPx) ?? Number.NaN) : null;
    const side = posSz > 0 ? "long" : posSz < 0 ? "short" : "flat";
    const entryVsMid = bpsBetween(entry, book.mid);
    // Flip the short so that above zero always means the position is winning.
    const gainBps = side === "flat" || entryVsMid == null ? null : side === "short" ? -entryVsMid : entryVsMid;
    this.trackPath(block, gainBps, Math.abs(posSz) * book.mid);
    this.feeTrail.push({ block, usd: this.totals.gasUsd });
    if (this.feeTrail.length > RECENT_TICKS + 10) this.feeTrail.shift();
    const t = this.track;
    const vol = mtf["1m"]?.vol20Bps ?? null;
    return {
      coin: this.market.coin,
      market: this.market.pair,
      venue: config.venue,
      tick: block,
      tickMs: config.tickMs,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(" "),
      trades: this.trades ? this.trades.summary(H, block) : emptySummary(),
      recentTrades: (this.trades?.recent(10) ?? []).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      flow: this.trades ? roundFlow(this.trades.flow(block, flowWindows())) : {},
      sizing,
      lastTick: this.lastAnswer(),
      recent: this.recentTrading(block),
      position: {
        coin: this.market.coin,
        side,
        size: round(Math.abs(posSz), 8),
        notionalUsd: round(Math.abs(posSz) * book.mid, 4),
        entry,
        leverage: a?.leverage ?? null,
        liquidationPx: a?.liquidationPx ?? null,
        entryVsMidBps: rnull(entryVsMid, 2),
        liquidationDistBps: rnull(liqDist, 2),
        unrealizedUsd: round(unrealized, 4),
        ageTicks: t ? block - t.openedAt + 1 : 0,
        peakBps: t ? round(t.peak, 2) : null,
        fromPeakBps: t && gainBps != null ? round(t.peak - gainBps, 2) : null,
        ticksSincePeak: t ? block - t.peakAt : null,
        peakVsVol: t && vol ? round(t.peak / vol, 2) : null,
        costToCloseBps: round(book.spreadBps / 2 + this.market.takerFeeBps, 2),
        pathBps: t ? t.path.join(" ") : "",
      },
      mtf,
      asset: { ...asset, openInterestChangeBps: rnull(oiChangeBps, 2), maxLeverage: this.market.maxLeverage },
      maxLeverage: this.market.maxLeverage,
    };
  }

  private applyFill(f: Fill) {
    if (f.size <= 0) return;
    if (this.market.account) return;
    this.totals.fills++;
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    if (p.sz === 0 || Math.sign(p.sz) === Math.sign(signed)) {
      p.costUsd += signed * f.price;
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.sz)) * Math.sign(signed);
      const entry = p.costUsd / p.sz;
      this.totals.realizedUsd += -closing * (f.price - entry);
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price;
    }
    p.sz += signed;
    if (Math.abs(p.sz) < 1e-9) { p.sz = 0; p.costUsd = 0; }
    if (f.feeUsd) this.totals.gasUsd += f.feeUsd;
  }

  private syncFromVenue() {
    const a = this.market.account;
    if (!a) return;
    this.position.sz = a.positionSz;
    this.position.costUsd = a.entryPrice != null && a.positionSz ? a.entryPrice * a.positionSz : 0;
    this.totals.realizedUsd = a.realizedUsd;
    this.totals.gasUsd = a.feesUsd;
    this.totals.fills = this.market.fillPrints.length;
  }

  private entryPrice() { return this.position.sz ? this.position.costUsd / this.position.sz : null; }
  private unrealizedUsd(mid: number) { return this.position.sz ? this.position.sz * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: ModelDecision | null, quote: Quote | null, late: boolean, timing?: Timing) {
    this.syncFromVenue();
    const t = this.totals;
    t.gasSz = book.mid ? t.gasUsd / book.mid : 0;
    const a = this.market.account;
    const unrealized = a ? a.unrealizedUsd : this.unrealizedUsd(book.mid);
    t.pnlUsd = t.realizedUsd + unrealized - t.gasUsd;
    t.pnlSz = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / (a?.accountValue || config.bankrollUsd)) * 100;
    const size = Math.abs(this.position.sz);
    const event: BlockEvent = {
      coin: this.market.coin,
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && {
          action: decision.action,
          intent: decision.intent,
          bias: decision.bias,
          trend: decision.trend,
          exitStyle: decision.exitStyle,
          leverage: decision.leverage,
          probabilities: decision.probabilities,
          upIn10: decision.upIn10,
          latencyMs: Math.round(decision.latencyMs),
          late: false,
        },
      quote,
      fill: null,
      resting: { bidSz: round(this.restingSz("buy"), this.market.sizeDecimals), askSz: round(this.restingSz("sell"), this.market.sizeDecimals) },
      position: {
        side: this.position.sz > 0 ? "long" : this.position.sz < 0 ? "short" : "flat",
        size,
        entryPrice: this.entryPrice(),
        leverage: a?.leverage ?? decision?.leverage ?? null,
        unrealizedUsd: round(unrealized, 6),
        unrealizedSz: round(unrealized / book.mid, 8),
        markPx: this.market.assetCtx?.markPx ?? null,
      },
      totals: { ...t, jevUsd: round(t.jevUsd, 6), gasSz: round(t.gasSz, 8), gasUsd: round(t.gasUsd, 6), realizedUsd: round(t.realizedUsd, 6), pnlUsd: round(t.pnlUsd, 6), pnlSz: round(t.pnlSz, 8), pnlPct: round(t.pnlPct, 4) },
      accountValue: a && Number.isFinite(a.accountValue) ? round(a.accountValue, 2) : null,
      withdrawable: a && Number.isFinite(a.withdrawable) ? round(a.withdrawable, 2) : null,
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    this.onEvent(event, timing);
  }
}

/** Near, middle, and the full lookback. Deduped so a short horizon cannot collapse them. */
function flowWindows(): number[] {
  return [...new Set([5, 20, config.horizonBlocks].filter((w) => w > 0))].sort((a, b) => a - b);
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

function roundFlow(flow: Record<string, FlowWindow>): Record<string, FlowWindow> {
  const out: Record<string, FlowWindow> = {};
  for (const [w, v] of Object.entries(flow)) {
    out[w] = {
      count: v.count,
      buySz: round(v.buySz, 3),
      sellSz: round(v.sellSz, 3),
      cvdSz: round(v.cvdSz, 3),
      imbalance: round(v.imbalance, 3),
      maxBuySz: round(v.maxBuySz, 3),
      maxSellSz: round(v.maxSellSz, 3),
    };
  }
  return out;
}
const rnull = (x: number | null, d: number) => (x == null || !Number.isFinite(x) ? null : round(x, d));

function snapNums<T extends Record<string, number | null>>(obj: T): T {
  const out = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    (out as Record<string, number | null>)[k] = typeof v === "number" ? round(v, 6) : v;
  }
  return out;
}
