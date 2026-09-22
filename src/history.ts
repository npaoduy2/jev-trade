import type { VenueFillPrint } from "./venue";

/**
 * Rebuilding what a restart forgets.
 *
 * A desk keeps a position's peak, the path it took, and how often it has been
 * going around, all in memory. Those are exactly the numbers that argue against
 * closing a winner early, so losing them on every restart blinds Jev to why it
 * is holding what it holds. The venue remembers the fills, so the rest can be
 * derived rather than persisted.
 */

export interface Trip {
  closedAt: number;
  heldMs: number;
  notionalUsd: number;
}

const signed = (f: VenueFillPrint) => (f.side === "buy" ? f.size : -f.size);

/** When the position that is open right now first left flat. Null if flat. */
export function openedAt(fills: VenueFillPrint[]): number | null {
  const rows = [...fills].sort((a, b) => a.ts - b.ts);
  let sz = 0;
  let since: number | null = null;
  for (const f of rows) {
    if (Math.abs(sz) < 1e-9) since = f.ts;
    sz += signed(f);
    if (Math.abs(sz) < 1e-9) since = null;
  }
  return since;
}

/** Every round trip the venue has a record of, oldest first. */
export function completedTrips(fills: VenueFillPrint[]): Trip[] {
  const rows = [...fills].sort((a, b) => a.ts - b.ts);
  const out: Trip[] = [];
  let sz = 0;
  let since = 0;
  let notional = 0;
  for (const f of rows) {
    if (Math.abs(sz) < 1e-9) {
      since = f.ts;
      notional = 0;
    }
    sz += signed(f);
    notional = Math.max(notional, Math.abs(sz) * f.price);
    if (Math.abs(sz) < 1e-9) out.push({ closedAt: f.ts, heldMs: f.ts - since, notionalUsd: notional });
  }
  return out;
}

/**
 * Walk an open position's gain across the bars it has lived through. `closes`
 * is oldest first and covers the position's life. The gain is flipped for a
 * short so above zero always means it is winning.
 */
export function replayGain(
  closes: number[],
  entry: number,
  isShort: boolean,
): { peak: number; peakIdx: number; path: number[] } | null {
  if (!(entry > 0) || !closes.length) return null;
  const path: number[] = [];
  let peak = Number.NEGATIVE_INFINITY;
  let peakIdx = 0;
  closes.forEach((c, i) => {
    const raw = ((c - entry) / entry) * 10_000;
    const gain = isShort ? -raw : raw;
    path.push(Math.round(gain * 10) / 10);
    if (gain > peak) {
      peak = gain;
      peakIdx = i;
    }
  });
  return { peak, peakIdx, path };
}
