import { expect, test } from "bun:test";
import { pullResting, repeatMeansGiveUp, type VenueMarket } from "../src/venue";
import type { Model, ModelDecision, TradeState } from "../src/model";
import { leverageRungs, liveIntent, parseLeverage, planQuote, quoteAction } from "../src/plan";
import { TradeFeed } from "../src/trades";
import { jevUnavailable, Trader } from "../src/trader";
import type { BlockEvent, Book, Quote, Side } from "../src/types";

test("jevUnavailable detects a TypeSafe credit 402", () => {
  expect(jevUnavailable(new Error("402 Your organization has no available TypeSafe API credits. Please add more credits"))).toBe(true);
  expect(jevUnavailable(new Error("hyperliquid rate limited"))).toBe(false);
});

test("open long buys and open short sells, resting post-only", () => {
  expect(quoteAction("open", "long")).toBe("buy");
  expect(quoteAction("open", "short")).toBe("sell");
  expect(planQuote({ intent: "open", bias: "long", positionSz: -2, quoteSz: 0.01 })).toEqual({
    side: "buy", size: 0.01, reduceOnly: false, taker: false,
  });
  expect(planQuote({ intent: "open", bias: "short", positionSz: 2, quoteSz: 0.01 })).toEqual({
    side: "sell", size: 0.01, reduceOnly: false, taker: false,
  });
});

test("close flattens the live book as a taker and skips when flat", () => {
  expect(planQuote({ intent: "close", bias: "long", positionSz: 0.08, quoteSz: 0.01 })).toEqual({
    side: "sell", size: 0.08, reduceOnly: true, taker: true,
  });
  expect(planQuote({ intent: "close", bias: "short", positionSz: -0.08, quoteSz: 0.01 })).toEqual({
    side: "buy", size: 0.08, reduceOnly: true, taker: true,
  });
  expect(planQuote({ intent: "close", bias: "long", positionSz: -0.08, quoteSz: 0.01 })).toEqual({
    side: "buy", size: 0.08, reduceOnly: true, taker: true,
  });
  expect(planQuote({ intent: "close", bias: "short", positionSz: 0.08, quoteSz: 0.01 })).toEqual({
    side: "sell", size: 0.08, reduceOnly: true, taker: true,
  });
  expect(planQuote({ intent: "close", bias: "long", positionSz: 0, quoteSz: 0.01 })).toBe(null);
});

test("hold sends nothing, whatever the bias or position", () => {
  expect(quoteAction("hold", "long")).toBe("hold");
  expect(quoteAction("hold", "short")).toBe("hold");
  expect(planQuote({ intent: "hold", bias: "long", positionSz: 0, quoteSz: 0.01 })).toBe(null);
  expect(planQuote({ intent: "hold", bias: "short", positionSz: 0.08, quoteSz: 0.01 })).toBe(null);
  expect(planQuote({ intent: "hold", bias: "long", positionSz: -0.08, quoteSz: 0.01 })).toBe(null);
});

test("liveIntent cannot close a flat book and stands down instead", () => {
  expect(liveIntent("flat", "close")).toBe("hold");
  expect(liveIntent("flat", "hold")).toBe("hold");
  expect(liveIntent("flat", "open")).toBe("open");
  expect(liveIntent("long", "close")).toBe("close");
  expect(liveIntent("long", "hold")).toBe("hold");
  expect(liveIntent("short", "open")).toBe("open");
});

test("leverage rungs follow the coin max", () => {
  expect(leverageRungs(10)).toEqual([1, 2, 3, 5, 10]);
  expect(leverageRungs(50)).toEqual([1, 2, 3, 5, 10, 20, 40, 50]);
  expect(leverageRungs(15)).toEqual([1, 2, 3, 5, 10, 15]);
  expect(parseLeverage("7", 10, 1)).toBe(5);
  expect(parseLeverage("50", 10, 1)).toBe(10);
});

const book: Book = {
  block: 1,
  bid: 99.9,
  ask: 100.1,
  mid: 100,
  spreadBps: 20,
  imbalance: 0,
  levels: { bids: [[99.9, 1]], asks: [[100.1, 1]] },
  depthBps: { "10": { bid: 1, ask: 1 } },
};

function packed(partial: Partial<ModelDecision> & Pick<ModelDecision, "intent" | "bias" | "action">): ModelDecision {
  return {
    trend: "unclear",
    exitStyle: "cross",
    leverage: 1,
    probabilities: { buy: 0, sell: 0, hold: 1, long: 0.5, short: 0.5, open: 0, close: 0 },
    upIn10: 0.5,
    latencyMs: 1,
    inputTokens: 0,
    ...partial,
  };
}

class ScriptModel implements Model {
  readonly name = "script";
  next: ModelDecision | Error = packed({ intent: "hold", bias: "long", action: "hold" });
  delayMs = 0;
  seen: TradeState | null = null;
  async decide(state?: TradeState): Promise<ModelDecision> {
    if (state) this.seen = state;
    if (this.delayMs) await Bun.sleep(this.delayMs);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

class FakeMarket {
  readonly coin = "BTC";
  readonly pair = "BTC-USD";
  readonly liveKey = false;
  readonly account = null;
  readonly sizeDecimals = 5;
  readonly maxLeverage = 40;
  readonly takerFeeBps = 4.5;
  readonly fillPrints: [] = [];
  assetCtx = null;
  lastOid: number | null = null;
  cancels = 0;
  sendDelayMs = 0;
  sentBook: Book | null = null;
  private live: Book = book;
  moveBookTo(next: Book) { this.live = next; }
  candleCloses() { return []; }
  tfCloses() { return []; }
  refresh() { return Promise.resolve(); }
  readBook() { return this.live; }
  quoteSize() { return 0.01; }
  setLeverage(n: number) { return Promise.resolve(n); }
  async send(side: Side, size: number, book_: Book, cancel: number[]): Promise<Quote> {
    this.sentBook = book_;
    if (this.sendDelayMs) await Bun.sleep(this.sendDelayMs);
    this.lastOid = 4242;
    return {
      side, price: 99.9, size, txHash: null, cancel, status: "placed",
      orderId: 4242, capped: false, reduceOnly: false, taker: false,
    };
  }
  async cancelResting() {
    this.cancels++;
    const oid = this.lastOid;
    this.lastOid = null;
    return oid == null ? [] : [oid];
  }
}

function desk(model: ScriptModel, market = new FakeMarket()) {
  const events: BlockEvent[] = [];
  const trader = new Trader(market as unknown as VenueMarket, model, (e) => events.push(e));
  return { trader, market, events };
}

test("a hold tick pulls an in-flight quote before it can rest", async () => {
  const model = new ScriptModel();
  const { trader, market } = desk(model);
  market.sendDelayMs = 80;
  model.next = packed({ intent: "open", bias: "long", action: "buy" });
  const open = trader.onBlock(1);
  await Bun.sleep(10);
  model.next = packed({ intent: "hold", bias: "long", action: "hold" });
  await trader.onBlock(2);
  await open;
  await Bun.sleep(120);
  expect(market.cancels).toBeGreaterThan(0);
});

test("a busy tick still emits late so the desk can show it", async () => {
  const model = new ScriptModel();
  const { trader, events } = desk(model);
  model.delayMs = 40;
  const first = trader.onBlock(1);
  await Bun.sleep(5);
  await trader.onBlock(2);
  await first;
  expect(events.some((e) => e.block === 2 && e.decision?.late === true)).toBe(true);
});

test("a failed Jev call emits late instead of going silent", async () => {
  const model = new ScriptModel();
  const { events, trader } = desk(model);
  model.next = new Error("boom");
  await trader.onBlock(1);
  expect(events.some((e) => e.decision?.late === true)).toBe(true);
});

test("an entry is priced off the book at send time, not the one the tick opened with", async () => {
  const model = new ScriptModel();
  const market = new FakeMarket();
  const { trader } = desk(model, market);
  model.next = packed({ intent: "open", bias: "long", action: "buy" });
  // The touch moves while Jev is answering, the way it does across two rounds.
  model.delayMs = 20;
  market.moveBookTo({ ...book, bid: 120, ask: 120.2, mid: 120.1 });
  await trader.onBlock(1);
  await Bun.sleep(60);
  expect(market.sentBook?.mid).toBe(120.1);
});

test("shutdown pulls every resting order, and one stuck sleeve does not strand the rest", async () => {
  const pulled = await pullResting(
    [
      { cancelOpen: async () => [11, 12] },
      { cancelOpen: async () => { throw new Error("venue said no"); } },
      { cancelOpen: async () => [] },
      { cancelOpen: async () => [13] },
    ],
    1_000,
  );
  expect(pulled).toEqual([11, 12, 13]);
});

test("shutdown reports rather than hangs when the venue stops answering", async () => {
  const pulled = await pullResting([{ cancelOpen: () => new Promise<number[]>(() => {}) }], 20);
  expect(pulled).toBe(null);
});

test("a hold leaves the unfilled part of an entry working instead of stranding Jev", async () => {
  const model = new ScriptModel();
  const market = new FakeMarket();
  const { trader } = desk(model, market);
  const feed = new TradeFeed();
  trader.attachTradeFeed(feed);

  model.next = packed({ intent: "open", bias: "long", action: "buy" });
  await trader.onBlock(1);
  await Bun.sleep(20);

  // The maker entry takes 0.003 of the 0.01 Jev asked for.
  feed.pushPrint({ block: 2, price: 99.8, size: 0.003, side: "sell" });
  model.next = packed({ intent: "hold", bias: "long", action: "hold" });
  await trader.onBlock(2);
  await Bun.sleep(20);
  expect(market.cancels).toBe(0);

  // Once the rest lands, a hold has nothing left to work and stands the book down.
  feed.pushPrint({ block: 3, price: 99.8, size: 0.007, side: "sell" });
  await trader.onBlock(3);
  await Bun.sleep(20);
  expect(market.cancels).toBeGreaterThan(0);
});

test("a close drops the entry, so a later hold does not revive it", async () => {
  const model = new ScriptModel();
  const market = new FakeMarket();
  const { trader } = desk(model, market);
  const feed = new TradeFeed();
  trader.attachTradeFeed(feed);

  model.next = packed({ intent: "open", bias: "long", action: "buy" });
  await trader.onBlock(1);
  await Bun.sleep(20);
  feed.pushPrint({ block: 2, price: 99.8, size: 0.003, side: "sell" });

  model.next = packed({ intent: "close", bias: "long", action: "sell" });
  await trader.onBlock(2);
  await Bun.sleep(20);

  const before = market.cancels;
  model.next = packed({ intent: "hold", bias: "long", action: "hold" });
  await trader.onBlock(3);
  await Bun.sleep(20);
  expect(market.cancels).toBeGreaterThan(before);
});

test("a stop signal repeated in the same breath does not abandon the cancel", () => {
  const first = 1_000_000;
  // A process manager firing SIGTERM twice back to back.
  expect(repeatMeansGiveUp(first, first)).toBe(false);
  expect(repeatMeansGiveUp(first, first + 5)).toBe(false);
  expect(repeatMeansGiveUp(first, first + 999)).toBe(false);
  // A person pressing again because the exit is taking too long.
  expect(repeatMeansGiveUp(first, first + 1_000)).toBe(true);
  expect(repeatMeansGiveUp(first, first + 4_000)).toBe(true);
  // Nothing in flight yet.
  expect(repeatMeansGiveUp(0, first)).toBe(false);
});

test("an open position carries where it has been, not just where it is", async () => {
  const model = new ScriptModel();
  const market = new FakeMarket();
  const { trader } = desk(model, market);
  const feed = new TradeFeed();
  trader.attachTradeFeed(feed);

  const at = (mid: number) => market.moveBookTo({ ...book, bid: mid - 0.05, ask: mid + 0.05, mid });

  model.next = packed({ intent: "open", bias: "long", action: "buy" });
  await trader.onBlock(1);
  await Bun.sleep(20);
  feed.pushPrint({ block: 2, price: 99.8, size: 0.01, side: "sell" });

  model.next = packed({ intent: "hold", bias: "long", action: "hold" });
  at(101);          // the position runs
  await trader.onBlock(2);
  at(102);          // and runs further: this is the peak
  await trader.onBlock(3);
  at(100.5);        // then hands some of it back
  await trader.onBlock(4);
  at(100.2);
  await trader.onBlock(5);

  const p = model.seen!.position;
  expect(p.side).toBe("long");
  expect(p.ageTicks).toBe(4);
  // Entry was 99.9, so the peak at 102 is about 210bps and the position now sits near 30.
  expect(p.peakBps!).toBeGreaterThan(200);
  expect(p.fromPeakBps!).toBeGreaterThan(150);
  expect(p.ticksSincePeak).toBe(2);
  expect(p.pathBps.split(" ").length).toBe(4);
  expect(p.costToCloseBps!).toBeGreaterThan(4.5);
});

test("going flat forgets the path so the next position starts clean", async () => {
  const model = new ScriptModel();
  const market = new FakeMarket();
  const { trader } = desk(model, market);
  model.next = packed({ intent: "hold", bias: "long", action: "hold" });
  await trader.onBlock(1);
  const p = model.seen!.position;
  expect(p.side).toBe("flat");
  expect(p.ageTicks).toBe(0);
  expect(p.peakBps).toBe(null);
  expect(p.pathBps).toBe("");
  // The cost of crossing is a fact about the book, known with or without a position.
  expect(p.costToCloseBps).toBeGreaterThan(0);
});

test("a resting exit posts at the touch, a crossing one takes it", () => {
  const rest = planQuote({ intent: "close", bias: "long", positionSz: 0.08, quoteSz: 0.01, exitStyle: "rest" });
  expect(rest).toEqual({ side: "sell", size: 0.08, reduceOnly: true, taker: false });

  const cross = planQuote({ intent: "close", bias: "long", positionSz: 0.08, quoteSz: 0.01, exitStyle: "cross" });
  expect(cross).toEqual({ side: "sell", size: 0.08, reduceOnly: true, taker: true });

  // Saying nothing still crosses, which is what an exit did before there was a choice.
  const silent = planQuote({ intent: "close", bias: "short", positionSz: -0.08, quoteSz: 0.01 });
  expect(silent).toEqual({ side: "buy", size: 0.08, reduceOnly: true, taker: true });
});
