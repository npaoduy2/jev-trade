import { experimental_evaluate as evaluate } from "ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { assertJevCredentials, config } from "./config";
import type { IndicatorSnap } from "./indicators";
import { leverageRungs, parseLeverage, quoteAction, type Bias, type Intent } from "./plan";
import type { Action, Bias as WireBias, Intent as WireIntent, Side, Trend } from "./types";
import type { FlowWindow } from "./trades";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  coin: string;
  market: string;
  tick: number;
  tickMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number;
  /** Cumulative resting size within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string;
  /** Taker prints in the lookback window. cvdSz = taker buy size minus taker sell size. */
  trades: { count: number; buySz: number; sellSz: number; cvdSz: number; vwap: number | null; lastPrice: number | null; lastSide: Side | null };
  recentTrades: string[];
  /** Taker flow over several lookbacks, keyed "<ticks>t". */
  flow: { [window: string]: FlowWindow };
  /** Notional one entry would carry at each leverage rung, keyed by the rung. */
  sizing: { [rung: string]: number };
  /** What Jev answered on the previous tick. null on the first one. */
  lastTick: { trend: Trend; intent: WireIntent; bias: WireBias; leverage: number } | null;
  position: {
    coin: string;
    side: "long" | "short" | "flat";
    size: number;
    notionalUsd: number;
    entry: number | null;
    leverage: number | null;
    liquidationPx: number | null;
    /** Mid against entry, signed, not flipped for a short. */
    entryVsMidBps: number | null;
    /** Mid to liquidationPx, absolute. Distinct from entryVsMidBps. */
    liquidationDistBps: number | null;
    unrealizedUsd: number;
  };
  /** One read per venue interval, keyed 1m/15m/1h/4h/1d. Same shape for each. */
  mtf: { [tf: string]: IndicatorSnap };
  asset: {
    markPx: number | null;
    oraclePx: number | null;
    fundingBps: number | null;
    premiumBps: number | null;
    openInterest: number | null;
    /** Open interest against the previous tick. A level alone carries no direction. */
    openInterestChangeBps: number | null;
    dayNtlVlmUsd: number | null;
    dayChangeBps: number | null;
    maxLeverage: number;
  };
  maxLeverage: number;
}

export interface ModelDecision {
  action: Action;
  intent: Intent;
  bias: Bias;
  trend: Trend;
  leverage: number;
  probabilities: {
    buy: number;
    sell: number;
    hold: number;
    long: number;
    short: number;
    open: number;
    close: number;
  };
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<ModelDecision>;
}

/** Book, tape, and the open position. Wallet fills and lifetime PnL stay off this object. */
export function marketFacing(state: TradeState, read: { trend: Trend } | null = null) {
  const pos = state.position;
  return {
    guide: fieldGuide(state),
    /** Jev's own trend answer for this tick. null while that answer is pending. */
    read,
    coin: state.coin,
    market: state.market,
    tick: state.tick,
    tickMs: state.tickMs,
    mid: state.mid,
    spreadBps: state.spreadBps,
    bookImbalance: state.bookImbalance,
    depth: state.depth,
    book: state.book,
    returnsBps: state.returnsBps,
    recentMids: state.recentMids,
    trades: state.trades,
    recentTrades: state.recentTrades,
    flow: state.flow,
    sizing: state.sizing,
    lastTick: state.lastTick,
    position: {
      coin: pos.coin,
      side: pos.side,
      size: pos.size,
      notionalUsd: pos.notionalUsd,
      entry: pos.entry,
      leverage: pos.leverage,
      liquidationPx: pos.liquidationPx,
      entryVsMidBps: pos.entryVsMidBps,
      liquidationDistBps: pos.liquidationDistBps,
      ...(pos.side === "flat" ? {} : { unrealizedUsd: pos.unrealizedUsd }),
    },
    mtf: state.mtf,
    asset: state.asset,
    maxLeverage: state.maxLeverage,
  };
}

/**
 * What each number means, in units and sign. Naming a field, or saying what an
 * action mechanically does, is not advice about when to act, so nothing here
 * says which option to pick.
 */
export function fieldGuide(state: TradeState): string {
  const asset = state.coin;
  return [
    `${asset} perp on Hyperliquid, ${state.market}. sizes in ${asset}, prices and notionals in quote currency. bps = 1e-4.`,
    `guide = this list. read = your own trend answer for this tick, null while it is pending.`,
    `mid = (bestBid+bestAsk)/2. spreadBps = (ask-bid)/mid in bps.`,
    `bookImbalance = (bidSz-askSz)/(bidSz+askSz) within 100bps of mid, above 0 = more resting bids.`,
    `depth[Nbps] = resting size within N bps of mid, per side. book = top 5 levels per side, best first, "price x size".`,
    `returnsBps.lastK = mid change over the last K ticks. recentMids = mid every 5 ticks, oldest first.`,
    `trades = taker prints over the full lookback. cvdSz = taker buy size minus taker sell size, above 0 = buyers lifting.`,
    `flow["Nt"] = the same tape over the last N ticks, so a build and a fade are distinguishable. imbalance = cvdSz over total size, -1..1.`,
    `recentTrades = "tick side size @ price", oldest first.`,
    `mtf = one read per venue interval, keyed 1m 15m 1h 4h 1d, identical fields in each.`,
    `mtf[tf].midVsEma200Bps = live mid against that interval's ema200. ema20VsEma200Bps = fast against slow there.`,
    `mtf[tf].rangePos20 = (close-low)/(high-low) over 20 bars, 0 at the low, 1 at the high.`,
    `mtf[tf].vol20Bps = stdev of log returns over 20 bars, in bps. changeBps = that interval's last bar against the one before.`,
    `asset = venue context. fundingBps above 0 = longs pay shorts. premiumBps = mark against oracle. openInterestChangeBps = oi against the previous tick.`,
    `sizing[rung] = the notional one entry carries at that leverage rung. margin locked is the same at every rung.`,
    `lastTick = the most recent answers you gave, null before the first one. late ticks can put it further back than one tick.`,
    `position.entryVsMidBps = mid against entry, signed, not flipped for a short.`,
    `position.liquidationDistBps = mid to liquidationPx, absolute.`,
    `null = not enough history for that field.`,
  ].join(" ");
}

const GUIDE_POINTER = "field guide in state.guide";

/** Phase one. Read the five intervals before any question about a side. */
export function jevTrendQuestion(state: TradeState) {
  const pos = state.position;
  const stance = pos.side === "flat"
    ? `flat ${state.coin}`
    : `${pos.side} ${pos.size} ${state.coin} @ ${pos.entry ?? "?"}`;
  return {
    trend: {
      type: "choice",
      instructions: {
        question: `${state.coin} trend across 1m 15m 1h 4h 1d?`,
        goal: `${state.market}`,
        timing: `tickMs=${state.tickMs}. position=${stance}.`,
        inputs: GUIDE_POINTER,
      },
      criteria: {
        up: "trending up",
        down: "trending down",
        range: "ranging",
        unclear: "no clear read",
      },
    },
  };
}

/**
 * Phase two. Criteria say what each option does on the exchange, not when to
 * pick it, so a choice is made against its real consequence.
 */
export function jevActionQuestions(state: TradeState) {
  const asset = state.coin;
  const pos = state.position;
  const stance = pos.side === "flat"
    ? `flat ${asset}`
    : `${pos.side} ${pos.size} ${asset} @ ${pos.entry ?? "?"}`;
  const levNow = pos.leverage != null ? `${pos.leverage}x` : "unset";
  const rungs = leverageRungs(state.maxLeverage);
  const levCriteria: Record<string, string> = {};
  for (const n of rungs) {
    const ntl = state.sizing[String(n)];
    levCriteria[String(n)] = ntl != null ? `${n}x, entry carries ${ntl} notional` : `${n}x`;
  }
  const leverage = {
    type: "choice",
    instructions: {
      question: `cross leverage for ${asset}?`,
      goal: `current ${levNow}. max ${state.maxLeverage}x. the rung sets the notional sent, not the margin locked.`,
      timing: `rungs ${rungs.join(" ")}`,
      inputs: GUIDE_POINTER,
    },
    criteria: levCriteria,
  };
  if (pos.side === "flat") {
    return {
      entry: {
        type: "choice",
        instructions: {
          question: `long, short, or wait on ${asset}?`,
          goal: `position=${stance}.`,
          timing: `tickMs=${state.tickMs}`,
          inputs: GUIDE_POINTER,
        },
        criteria: {
          long: "buy to open, a post-only order that rests inside the touch",
          short: "sell to open, a post-only order that rests inside the touch",
          wait: "place nothing this tick and pull any resting order",
        },
      },
      leverage,
    };
  }
  return {
    manage: {
      type: "choice",
      instructions: {
        question: `close or hold the ${pos.side} on ${asset}?`,
        goal: `position=${stance}.`,
        timing: `tickMs=${state.tickMs}`,
        inputs: GUIDE_POINTER,
      },
      criteria: {
        close: `flatten all ${pos.size} now, an Ioc that crosses the touch`,
        hold: "keep the position and place nothing this tick",
      },
    },
    leverage,
  };
}

/** Both phases together. The live path asks them in order; this is the full set. */
export function jevQuestions(state: TradeState) {
  return { ...jevTrendQuestion(state), ...jevActionQuestions(state) };
}

const TRENDS = ["up", "down", "range", "unclear"] as const;

interface Packed {
  intent: Intent;
  bias: Bias;
  trend: Trend;
  leverage: number;
  longP: number;
  shortP: number;
  openP: number;
  closeP: number;
  holdP: number;
  latencyMs: number;
  inputTokens: number;
}

function pack(o: Packed): ModelDecision {
  const action = quoteAction(o.intent, o.bias);
  // long/short and open/close/hold are each a distribution. buy/sell are the legacy
  // pair: the mass behind the order actually being sent, discounted by the hold mass.
  const conviction = action === "buy"
    ? Math.max(o.longP, o.openP)
    : action === "sell"
      ? Math.max(o.shortP, o.closeP)
      : 0;
  const sized = conviction * (1 - o.holdP);
  return {
    action,
    intent: o.intent,
    bias: o.bias,
    trend: o.trend,
    leverage: o.leverage,
    probabilities: {
      buy: action === "buy" ? sized : 0,
      sell: action === "sell" ? sized : 0,
      hold: o.holdP,
      long: o.longP,
      short: o.shortP,
      open: o.openP,
      close: o.closeP,
    },
    upIn10: o.longP,
    latencyMs: o.latencyMs,
    inputTokens: o.inputTokens,
  };
}

function normChoice(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const n = normChoice(raw);
  return (allowed as readonly string[]).includes(n) ? n as T : fallback;
}

function pickKnown<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  const n = normChoice(raw);
  return (allowed as readonly string[]).includes(n) ? n as T : null;
}

/** Normalize a choice answer over `keys`. Missing probabilities fall back to the pick. */
function choiceProbs(answer: ChoiceAnswer | undefined, keys: readonly string[]): Record<string, number> {
  const choice = normChoice(answer?.choice);
  const p = answer?.probabilities ?? {};
  const raw = keys.map((k) => Math.max(0, p[k] ?? (choice === k ? 1 : 0)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  if (sum <= 0) {
    const at = keys.indexOf(choice);
    if (at < 0) {
      keys.forEach((k) => { out[k] = 1 / keys.length; });
      return out;
    }
    keys.forEach((k, i) => { out[k] = i === at ? 1 : 0; });
    return out;
  }
  keys.forEach((k, i) => { out[k] = raw[i]! / sum; });
  return out;
}

type ChoiceAnswer = { choice?: string; probabilities?: Record<string, number> };
type JevAnswers = { trend?: ChoiceAnswer; entry?: ChoiceAnswer; manage?: ChoiceAnswer; leverage?: ChoiceAnswer };

/**
 * Map a Jev answer set onto one tick. Flat asks for a side, an open position asks
 * whether to keep it. A side we cannot read is a wait, not a long.
 */
export function decideFromJevAnswers(
  answers: JevAnswers,
  positionSide: "long" | "short" | "flat",
  maxLeverage: number,
  currentLeverage: number | null,
  latencyMs = 0,
  inputTokens = 0,
): ModelDecision {
  const dir = choiceProbs(answers.trend, TRENDS);
  const swing = dir.up! + dir.down!;
  const common = {
    trend: pick(answers.trend?.choice, TRENDS, "unclear"),
    leverage: parseLeverage(answers.leverage?.choice, maxLeverage, currentLeverage ?? 1),
    longP: swing > 0 ? dir.up! / swing : 0.5,
    shortP: swing > 0 ? dir.down! / swing : 0.5,
    latencyMs,
    inputTokens,
  };
  if (positionSide === "flat") {
    const entry = pickKnown(answers.entry?.choice, ["long", "short", "wait"] as const);
    const act = choiceProbs(answers.entry, ["long", "short", "wait"]);
    return pack({
      ...common,
      intent: entry === "long" || entry === "short" ? "open" : "hold",
      bias: entry === "short" ? "short" : "long",
      openP: act.long! + act.short!,
      closeP: 0,
      holdP: act.wait!,
    });
  }
  const act = choiceProbs(answers.manage, ["close", "hold"]);
  return pack({
    ...common,
    intent: pick(answers.manage?.choice, ["close", "hold"] as const, "hold"),
    // Closing a long sells. The stance is the position being held, not a fresh view.
    bias: positionSide,
    openP: 0,
    closeP: act.close!,
    holdP: act.hold!,
  });
}

let typesafe: TypeSafeClient | undefined;

function typesafeClient(): TypeSafeClient {
  return (typesafe ??= new TypeSafeClient({
    apiKey: process.env.TYPESAFE_API_KEY,
    defaultModel: config.jevModelId,
    retry: { maxRetries: 0 },
  }));
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`jev timeout ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

interface Asked {
  answers: JevAnswers;
  inputTokens: number;
}

async function ask(seen: unknown, questions: unknown): Promise<Asked> {
  if (config.jevProvider === "gateway") {
    const r = await evaluate({
      model: config.jevModelId,
      state: seen as never,
      questions: questions as never,
      maxRetries: 0,
    });
    return { answers: r.answers as JevAnswers, inputTokens: r.usage?.inputTokens ?? 0 };
  }
  const r = await typesafeClient().systemOne(
    {
      model: config.jevModelId,
      state: seen as never,
      questions: questions as never,
    },
    { retry: { maxRetries: 0 } },
  );
  return { answers: r.answers as JevAnswers, inputTokens: r.usage.input_tokens ?? 0 };
}

/**
 * Two rounds on one tick. The first reads the intervals, the second decides with
 * that read sitting in the state. A single flat question map carries no ordering,
 * so the trend answer would otherwise race the side it is supposed to inform.
 */
async function callJev(state: TradeState): Promise<Asked> {
  const run = async (): Promise<Asked> => {
    const first = await ask(marketFacing(state), jevTrendQuestion(state));
    const trend = pick(first.answers.trend?.choice, TRENDS, "unclear");
    const second = await ask(marketFacing(state, { trend }), jevActionQuestions(state));
    return {
      answers: { ...first.answers, ...second.answers },
      inputTokens: first.inputTokens + second.inputTokens,
    };
  };
  return withDeadline(run(), config.jevDeadlineMs);
}

/** Real Jev. JEV_PROVIDER selects official TypeSafe or Vercel AI Gateway. */
export class JevModel implements Model {
  readonly name = "jev";

  async decide(state: TradeState): Promise<ModelDecision> {
    const t0 = performance.now();
    const r = await callJev(state);
    return decideFromJevAnswers(
      r.answers,
      state.position.side,
      state.maxLeverage,
      state.position.leverage,
      performance.now() - t0,
      r.inputTokens,
    );
  }
}

/** Deterministic stand-in: momentum + imbalance. Jev-shaped open/close/hold/long/short/leverage. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<ModelDecision> {
    const t0 = performance.now();
    const flow = state.trades.buySz + state.trades.sellSz ? state.trades.cvdSz / (state.trades.buySz + state.trades.sellSz) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(state.tick);
    const longP = 1 / (1 + Math.exp(-signal));
    const trend: Trend = signal > 0.35 ? "up" : signal < -0.35 ? "down" : "range";
    const side = state.position.side;
    // Flat picks a side or waits. An open position is only kept or closed.
    const bias: Bias = side === "flat" ? (longP >= 0.5 ? "long" : "short") : side;
    const against = (bias === "long" && signal < 0) || (bias === "short" && signal > 0);
    const intent: Intent = side === "flat"
      ? (Math.abs(signal) < 0.35 ? "hold" : "open")
      : (against ? "close" : "hold");
    const holdP = intent === "hold" ? 0.7 : 0.15;
    const closeP = intent === "close" ? 0.7 : 0.15;
    const leverage = parseLeverage(1 + Math.abs(signal) * 8, state.maxLeverage, state.position.leverage ?? 1);
    await Bun.sleep(80);
    return pack({
      intent,
      bias,
      trend,
      leverage,
      longP,
      shortP: 1 - longP,
      openP: Math.max(0, 1 - holdP - closeP),
      closeP,
      holdP,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    });
  }

  private noise(tick: number) {
    let h = tick * 2654435761 >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

export const createModel = (): Model => {
  if (config.model !== "jev") return new MockModel();
  assertJevCredentials(config.model, config.jevProvider, process.env);
  return new JevModel();
};
