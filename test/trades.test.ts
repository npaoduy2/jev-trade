import { expect, test } from "bun:test";
import { config } from "../src/config";
import { TradeFeed, aggregateFills, takeSimFills, type Resting } from "../src/trades";

test("takeSimFills hits a resting bid when a sell print crosses", () => {
  const orders = new Map<number, Resting>([[1, { side: "buy", price: 100, size: 0.002, block: 1 }]]);
  const fills = takeSimFills(orders, [{ block: 2, price: 99.9, size: 0.001, side: "sell" }]);
  expect(fills).toHaveLength(1);
  expect(fills[0]!.side).toBe("buy");
  expect(fills[0]!.size).toBeCloseTo(0.001, 8);
  expect(orders.get(1)!.size).toBeCloseTo(0.001, 8);
});

test("takeSimFills ignores prints before the quote tick", () => {
  const orders = new Map<number, Resting>([[1, { side: "sell", price: 100, size: 0.001, block: 5 }]]);
  expect(takeSimFills(orders, [{ block: 4, price: 101, size: 1, side: "buy" }])).toHaveLength(0);
});

test("aggregateFills keeps the heavier side", () => {
  const fill = aggregateFills([
    { side: "buy", size: 0.001, price: 10, txHash: "0x1", orderId: 1, simulated: true },
    { side: "sell", size: 0.003, price: 11, txHash: "0x2", orderId: 2, simulated: true },
  ]);
  expect(fill.side).toBe("sell");
  expect(fill.size).toBeCloseTo(0.003, 8);
  expect(fill.price).toBe(11);
});

test("the tape window holds every print the summary can still ask for", () => {
  const feed = new TradeFeed();
  const perTick = 20;
  for (let tick = 1; tick <= 300; tick++) {
    feed.setTick(tick);
    for (let i = 0; i < perTick; i++) {
      feed.pushPrint({ price: 77_000 + i, size: 0.1, side: i % 2 ? "buy" : "sell" });
    }
  }
  // A count-capped ring cut this to the last 500 prints, so a long window
  // reported a fraction of its own lookback.
  const seen = feed.summary(config.horizonBlocks, 300);
  expect(seen.count).toBe(config.horizonBlocks * perTick);
  expect(seen.buySz + seen.sellSz).toBeCloseTo(config.horizonBlocks * perTick * 0.1, 6);
});

test("prints older than the window are dropped", () => {
  const feed = new TradeFeed();
  feed.setTick(1);
  feed.pushPrint({ price: 100, size: 1, side: "buy" });
  feed.setTick(config.horizonBlocks + 2);
  expect(feed.summary(config.horizonBlocks, config.horizonBlocks + 2).count).toBe(0);
});

test("flow windows separate a fresh push from a fading one", () => {
  const feed = new TradeFeed();
  for (let tick = 1; tick <= 100; tick++) {
    feed.setTick(tick);
    // Sellers own the first 95 ticks, buyers take over at the end.
    const side = tick > 95 ? "buy" : "sell";
    for (let i = 0; i < 4; i++) feed.pushPrint({ price: 100, size: 1, side });
  }
  const f = feed.flow(100, [5, 20, 100]);
  expect(f["5t"]!.imbalance).toBe(1);
  expect(f["20t"]!.imbalance).toBeCloseTo((20 - 60) / 80, 6);
  expect(f["100t"]!.imbalance).toBeCloseTo((20 - 380) / 400, 6);
  expect(f["5t"]!.count).toBe(20);
  expect(f["100t"]!.count).toBe(400);
});
