import { expect, test } from "bun:test";
import { alignPrice, bookFromLevels, decimalsOfTick, gridFromTick, quotePrice, takerPrice } from "../src/book";
import { hlGrid } from "../src/hl/market";

/** Hyperliquid BTC: szDecimals 5 puts the perp on a 0.1 tick. */
const hl5 = hlGrid(5);

test("Hyperliquid BTC tick is 0.1 when szDecimals is 5", () => {
  expect(hl5.tick).toBe(0.1);
  expect(alignPrice(97123.46, hl5)).toBe(97123.5);
});

test("a grid takes its decimals from its tick", () => {
  expect(decimalsOfTick(0.1)).toBe(1);
  expect(decimalsOfTick(0.00001)).toBe(5);
  expect(decimalsOfTick(1)).toBe(0);
  expect(decimalsOfTick(1e-7)).toBe(7);
  // OKX states the tick outright, and demo quotes a finer one than live.
  expect(gridFromTick(0.01)).toEqual({ tick: 0.01, decimals: 2 });
  expect(alignPrice(97123.464, gridFromTick(0.01))).toBe(97123.46);
});

test("bookFromLevels mid spread imbalance", () => {
  const book = bookFromLevels(1, [
    { px: "100", sz: "2" },
    { px: "99.9", sz: "1" },
  ], [
    { px: "100.1", sz: "1" },
    { px: "100.2", sz: "4" },
  ]);
  expect(book).not.toBeNull();
  expect(book!.bid).toBe(100);
  expect(book!.ask).toBe(100.1);
  expect(book!.mid).toBeCloseTo(100.05, 8);
  expect(book!.spreadBps).toBeCloseTo(10, 1);
  expect(book!.levels.bids[0]).toEqual([100, 2]);
});

test("quotePrice stays inside the touch", () => {
  const book = bookFromLevels(1, [{ px: "100", sz: "1" }], [{ px: "100.2", sz: "1" }])!;
  expect(quotePrice("buy", book, hl5, 1)).toBe(100.1);
  expect(quotePrice("sell", book, hl5, 1)).toBe(100.1);
});

test("bookFromLevels synthesizes the missing side", () => {
  const asksOnly = bookFromLevels(1, [], [{ px: "218.09", sz: "0.05" }]);
  expect(asksOnly).not.toBeNull();
  expect(asksOnly!.ask).toBeCloseTo(218.09, 6);
  expect(asksOnly!.bid).toBeLessThan(asksOnly!.ask);
  const bidsOnly = bookFromLevels(1, [{ px: "218.09", sz: "0.05" }], []);
  expect(bidsOnly).not.toBeNull();
  expect(bidsOnly!.bid).toBeCloseTo(218.09, 6);
  expect(bidsOnly!.ask).toBeGreaterThan(bidsOnly!.bid);
});

test("quotePrice clamps when one tick would cross", () => {
  const book = bookFromLevels(1, [{ px: "100", sz: "1" }], [{ px: "100.1", sz: "1" }])!;
  expect(quotePrice("buy", book, hl5, 1)).toBe(100);
  expect(quotePrice("sell", book, hl5, 1)).toBe(100.1);
});

test("takerPrice crosses the touch so an exit fills now", () => {
  const book = bookFromLevels(1, [{ px: "100", sz: "1" }], [{ px: "100.2", sz: "1" }])!;
  // A buy exit lifts the ask and pays up, a sell exit hits the bid and gives up.
  expect(takerPrice("buy", book, hl5, 50)).toBeGreaterThan(book.ask);
  expect(takerPrice("sell", book, hl5, 50)).toBeLessThan(book.bid);
});

test("takerPrice rounds away from the touch, never back inside the spread", () => {
  const book = bookFromLevels(1, [{ px: "100", sz: "1" }], [{ px: "100.1", sz: "1" }])!;
  // 0 bps of slippage still has to clear the touch after tick alignment.
  expect(takerPrice("buy", book, hl5, 0)).toBeGreaterThanOrEqual(book.ask);
  expect(takerPrice("sell", book, hl5, 0)).toBeLessThanOrEqual(book.bid);
  // A slippage smaller than one tick must not round back across the mid.
  expect(takerPrice("buy", book, hl5, 0.001)).toBeGreaterThanOrEqual(book.ask);
  expect(takerPrice("sell", book, hl5, 0.001)).toBeLessThanOrEqual(book.bid);
});
