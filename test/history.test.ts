import { expect, test } from "bun:test";
import { completedTrips, openedAt, replayGain } from "../src/history";
import type { VenueFillPrint } from "../src/venue";

const f = (ts: number, side: "buy" | "sell", size: number, price = 100): VenueFillPrint =>
  ({ ts, side, price, size });

test("openedAt finds when the live position left flat, and nothing when it is flat", () => {
  // buy 1, sell 1 closes it, then buy 2 opens the one that is still on
  const fills = [f(1000, "buy", 1), f(2000, "sell", 1), f(5000, "buy", 2)];
  expect(openedAt(fills)).toBe(5000);

  expect(openedAt([f(1000, "buy", 1), f(2000, "sell", 1)])).toBe(null);
  expect(openedAt([])).toBe(null);

  // A position built in pieces dates from the first piece, not the last.
  expect(openedAt([f(1000, "buy", 1), f(3000, "buy", 1)])).toBe(1000);
});

test("completedTrips counts a round trip once, whatever it took to fill", () => {
  const fills = [
    f(1000, "buy", 1), f(1500, "buy", 1),        // one entry, two fills
    f(4000, "sell", 1), f(5000, "sell", 1),      // one exit, two fills
    f(9000, "sell", 3), f(9500, "buy", 3),       // a short, opened and closed
  ];
  const trips = completedTrips(fills);
  expect(trips.length).toBe(2);
  expect(trips[0]!.heldMs).toBe(4000);
  expect(trips[1]!.heldMs).toBe(500);
  // Notional is the largest the position reached, not the last fill's slice.
  expect(trips[0]!.notionalUsd).toBeCloseTo(200);
});

test("replayGain walks the path and flips it for a short", () => {
  const long = replayGain([100, 110, 105], 100, false)!;
  expect(long.path).toEqual([0, 1000, 500]);
  expect(long.peak).toBeCloseTo(1000);
  expect(long.peakIdx).toBe(1);

  const short = replayGain([100, 110, 105], 100, true)!;
  expect(short.path).toEqual([-0, -1000, -500]);
  expect(short.peak).toBeCloseTo(0);
  expect(short.peakIdx).toBe(0);

  expect(replayGain([], 100, false)).toBe(null);
  expect(replayGain([100], 0, false)).toBe(null);
});
