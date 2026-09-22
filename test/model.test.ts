import { expect, test } from "bun:test";
import { decideFromJevAnswers, fieldGuide, jevActionQuestions, jevQuestions, jevTrendQuestion, marketFacing, type TradeState } from "../src/model";
import { TIMEFRAMES } from "../src/timeframes";

const flatSnap = () => ({
  sma20: null, sma50: null, ema20: null, ema200: null,
  midVsSma20Bps: null, midVsSma50Bps: null, midVsEma200Bps: null, ema20VsEma200Bps: null,
  rsi14: null, vol20Bps: null, high20: null, low20: null, rangePos20: null, changeBps: null,
});

function fixture(side: TradeState["position"]["side"]): TradeState {
  return {
    coin: "BTC",
    market: "BTC-USD",
    tick: 1,
    tickMs: 60_000,
    mid: 77000,
    spreadBps: 0.13,
    bookImbalance: 0,
    depth: {},
    book: { bids: [], asks: [] },
    returnsBps: { last1: 0, last5: 0, last20: 0, last100: 0 },
    recentMids: "",
    trades: { count: 0, buySz: 0, sellSz: 0, cvdSz: 0, vwap: null, lastPrice: null, lastSide: null },
    recentTrades: [],
    flow: { "5t": { count: 0, buySz: 0, sellSz: 0, cvdSz: 0, imbalance: 0, maxBuySz: 0, maxSellSz: 0 } },
    sizing: { "1": 40, "2": 80, "3": 120, "5": 200, "10": 400, "20": 800, "40": 1600 },
    lastTick: null,
    recent: { windowTicks: 30, trips: 2, holdTicksMedian: 3, costBps: 6.1 },
    position: {
      coin: "BTC",
      side,
      size: side === "flat" ? 0 : 0.001,
      notionalUsd: side === "flat" ? 0 : 77,
      entry: side === "flat" ? null : 77000,
      leverage: 1,
      liquidationPx: null,
      entryVsMidBps: null,
      liquidationDistBps: null,
      unrealizedUsd: side === "flat" ? 0 : -1.25,
      ageTicks: side === "flat" ? 0 : 4,
      peakBps: side === "flat" ? null : 42.5,
      fromPeakBps: side === "flat" ? null : 30.1,
      ticksSincePeak: side === "flat" ? null : 2,
      peakVsVol: side === "flat" ? null : 5.3,
      costToCloseBps: 4.56,
      pathBps: side === "flat" ? "" : "0 20.4 42.5 12.4",
    },
    mtf: Object.fromEntries(TIMEFRAMES.map((tf) => [tf, flatSnap()])),
    asset: {
      markPx: null, oraclePx: null, fundingBps: null, premiumBps: null,
      openInterest: null, openInterestChangeBps: null, dayNtlVlmUsd: null, dayChangeBps: null, maxLeverage: 40,
    },
    maxLeverage: 40,
  };
}

function blob(side: TradeState["position"]["side"]) {
  return JSON.stringify(jevQuestions(fixture(side))).toLowerCase();
}

const scoreboard = [
  "recentfills",
  "this wallet",
  "realized",
  "feesusd",
  "pnlusd",
  "pnlpct",
  "pnl $",
  "equity=",
  "withdrawable",
  "worth paying",
  "not worth trading",
  "most ticks",
  "clears the spread",
  "round trip",
  "by more than the spread",
  "only when",
  "pick this when",
  "stay flat",
  "you are flat",
  "leave it alone",
  "ignored on a hold",
  "horizonticks",
  "no order",
  "spread=",
];

test("Jev reads the trend first, then names the actions, without coaching a pick", () => {
  const flat = blob("flat");
  const long = blob("long");
  for (const text of [flat, long]) {
    expect(text).toContain("btc trend across 1m 15m 1h 4h 1d?");
    expect(text).toContain('"up":"trending up"');
    expect(text).toContain('"range":"ranging"');
    for (const phrase of scoreboard) {
      expect(text).not.toContain(phrase);
    }
  }
  expect(flat).toContain("long, short, or wait on btc?");
  expect(flat).toContain('"wait":"place nothing');
  expect(long).toContain("close or hold the long on btc?");
  expect(long).toContain('"close_now":"flatten all');
  expect(long).toContain('"close_rest":"flatten all');
});

test("an open position is only asked to keep or close it", () => {
  const open = jevQuestions(fixture("long")) as Record<string, unknown>;
  expect(Object.keys(open).sort()).toEqual(["leverage", "manage", "trend"]);
  expect("entry" in open).toBe(false);
  const flat = jevQuestions(fixture("flat")) as Record<string, unknown>;
  expect(Object.keys(flat).sort()).toEqual(["entry", "leverage", "trend"]);
});

test("the field guide describes every block Jev is handed", () => {
  const guide = fieldGuide(fixture("long")).toLowerCase();
  const seen = marketFacing(fixture("long"));
  const selfEvident = new Set(["coin", "market", "tick", "tickms", "maxleverage", "mid"]);
  for (const key of Object.keys(seen)) {
    if (selfEvident.has(key.toLowerCase())) continue;
    expect(guide).toContain(key.toLowerCase());
  }
  // The position carries the most fields and the ones easiest to misread.
  const known = new Set(["coin", "side", "size", "notionalusd", "entry", "leverage", "liquidationpx"]);
  for (const key of Object.keys(seen.position)) {
    if (known.has(key.toLowerCase())) continue;
    expect(guide).toContain(key.toLowerCase());
  }
});

test("evaluate state is the book and live position, not the wallet scoreboard", () => {
  const fat = {
    ...fixture("flat"),
    recentFills: ["sell 0.001 @ 77000 close"],
    horizonTicks: 100,
    position: {
      ...fixture("flat").position,
      realizedUsd: -10.5,
      feesUsd: 3.8,
      pnlUsd: -14.3,
      pnlPct: -7,
      equity: 185,
      withdrawable: 185,
    },
  };
  const seen = marketFacing(fat as TradeState);
  const text = JSON.stringify(seen).toLowerCase();
  expect(seen.book).toEqual(fat.book);
  expect(seen.trades).toEqual(fat.trades);
  expect(seen.position.side).toBe("flat");
  expect("unrealizedUsd" in seen.position).toBe(false);
  // Match the JSON key, not a substring: "unrealizedUsd" contains "realizedUsd"
  // and is a field Jev is meant to have.
  for (const key of ["recentFills", "realizedUsd", "feesUsd", "pnlUsd", "pnlPct", "equity", "withdrawable", "horizonTicks"]) {
    expect(text).not.toContain(`"${key.toLowerCase()}"`);
  }
  expect(text).toContain('"guide"');

  const open = marketFacing(fixture("long"));
  expect(open.position.unrealizedUsd).toBe(-1.25);
  expect(JSON.stringify(open).toLowerCase()).not.toContain("pnlusd");
});

test("every venue interval reaches Jev", () => {
  const seen = marketFacing(fixture("flat"));
  expect(Object.keys(seen.mtf).sort()).toEqual([...TIMEFRAMES].sort());
});

test("a short answer keeps its case and still sells", () => {
  for (const choice of ["SHORT", "Short", " short "]) {
    const d = decideFromJevAnswers(
      { trend: { choice: "down" }, entry: { choice }, leverage: { choice: "2" } },
      "flat",
      40,
      1,
    );
    expect(d.bias).toBe("short");
    expect(d.intent).toBe("open");
    expect(d.action).toBe("sell");
    expect(d.trend).toBe("down");
  }
});

test("wait opens nothing", () => {
  const d = decideFromJevAnswers(
    { trend: { choice: "range" }, entry: { choice: "wait" }, leverage: { choice: "5" } },
    "flat",
    40,
    1,
  );
  expect(d.intent).toBe("hold");
  expect(d.action).toBe("hold");
  expect(d.trend).toBe("range");
});

test("an unreadable side waits instead of opening long", () => {
  const d = decideFromJevAnswers(
    { trend: { choice: "up" }, entry: { choice: "buy the dip" }, leverage: { choice: "5" } },
    "flat",
    40,
    1,
  );
  expect(d.intent).toBe("hold");
  expect(d.action).toBe("hold");
});

test("closing an open position trades against the side being held", () => {
  const long = decideFromJevAnswers(
    { trend: { choice: "down" }, manage: { choice: "close_now" }, leverage: { choice: "3" } },
    "long",
    40,
    3,
  );
  expect(long.intent).toBe("close");
  expect(long.action).toBe("sell");

  const short = decideFromJevAnswers(
    { trend: { choice: "up" }, manage: { choice: "close_now" }, leverage: { choice: "3" } },
    "short",
    40,
    3,
  );
  expect(short.action).toBe("buy");

  const kept = decideFromJevAnswers(
    { trend: { choice: "up" }, manage: { choice: "hold" }, leverage: { choice: "3" } },
    "long",
    40,
    3,
  );
  expect(kept.intent).toBe("hold");
  expect(kept.action).toBe("hold");
});

test("the trend answer carries the directional read", () => {
  const up = decideFromJevAnswers(
    { trend: { probabilities: { up: 0.7, down: 0.1, range: 0.1, unclear: 0.1 } }, manage: { choice: "hold" } },
    "long",
    40,
    1,
  );
  expect(up.probabilities.long).toBeCloseTo(0.875, 6);
  expect(up.probabilities.short).toBeCloseTo(0.125, 6);
  expect(up.upIn10).toBeCloseTo(0.875, 6);
});

test("the two phases split the questions so the trend answer lands first", () => {
  const first = jevTrendQuestion(fixture("flat"));
  expect(Object.keys(first)).toEqual(["trend"]);

  const second = jevActionQuestions(fixture("flat")) as Record<string, unknown>;
  expect("trend" in second).toBe(false);
  expect(Object.keys(second).sort()).toEqual(["entry", "leverage"]);

  const managing = jevActionQuestions(fixture("long")) as Record<string, unknown>;
  expect(Object.keys(managing).sort()).toEqual(["leverage", "manage"]);
});

test("phase two is handed Jev's own trend read, phase one is not", () => {
  const state = fixture("flat");
  expect(marketFacing(state).read).toBe(null);
  expect(marketFacing(state, { trend: "up" }).read).toEqual({ trend: "up" });
});

test("leverage criteria name the notional the rung actually sends", () => {
  const qs = jevActionQuestions(fixture("flat")) as {
    leverage: { criteria: Record<string, string> };
  };
  expect(qs.leverage.criteria["1"]).toContain("40");
  expect(qs.leverage.criteria["20"]).toContain("800");
  expect(qs.leverage.criteria["40"]).toContain("1600");
});

test("criteria say what an option does without saying when to pick it", () => {
  const flat = blob("flat");
  const long = blob("long");
  expect(flat).toContain("buy to open");
  expect(flat).toContain("place nothing this tick");
  expect(long).toContain("flatten all");
  for (const text of [flat, long]) {
    for (const phrase of scoreboard) {
      expect(text).not.toContain(phrase);
    }
  }
});

test("the guide is carried once on the state, not repeated per question", () => {
  const state = fixture("flat");
  const guide = fieldGuide(state);
  expect(marketFacing(state).guide).toBe(guide);
  expect(JSON.stringify(jevQuestions(state))).not.toContain(guide);
});

test("Jev sees its own previous answer when one exists", () => {
  const state = fixture("long");
  state.lastTick = { trend: "up", intent: "open", bias: "long", leverage: 5 };
  expect(marketFacing(state).lastTick).toEqual(state.lastTick);
  expect(fieldGuide(state)).toContain("lastTick");
});

test("Jev picks how an exit leaves, and an unreadable answer keeps the position", () => {
  const cross = decideFromJevAnswers(
    { trend: { choice: "down" }, manage: { choice: "close_now" } },
    "long", 40, 3,
  );
  expect(cross.intent).toBe("close");
  expect(cross.exitStyle).toBe("cross");

  const rest = decideFromJevAnswers(
    { trend: { choice: "down" }, manage: { choice: "close_rest" } },
    "long", 40, 3,
  );
  expect(rest.intent).toBe("close");
  expect(rest.exitStyle).toBe("rest");
  // Both are exits, so the close mass is the two of them together.
  expect(rest.probabilities.close).toBeGreaterThan(0);

  const unreadable = decideFromJevAnswers(
    { trend: { choice: "down" }, manage: { choice: "sell everything" } },
    "long", 40, 3,
  );
  expect(unreadable.intent).toBe("hold");
});
