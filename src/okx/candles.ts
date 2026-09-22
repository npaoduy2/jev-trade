import type { Ohlc } from "../chart";
import type { HigherTf, Timeframe } from "../timeframes";
import { publicGet } from "./rest";

/** OKX names the hour and up in capitals. `1h` is rejected outright. */
const BAR: Record<Timeframe, string> = {
  "1m": "1m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

export function okxBar(tf: Timeframe): string {
  return BAR[tf];
}

/** `/market/candles` caps a page here; `/market/history-candles` caps lower. */
const LIVE_PAGE = 300;
const HISTORY_PAGE = 100;

type Row = string[];

function toOhlc(row: Row): Ohlc | null {
  const ts = Number(row[0]);
  const close = Number(row[4]);
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(close) || close <= 0) return null;
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const o = Number.isFinite(open) && open > 0 ? open : close;
  const h = Number.isFinite(high) && high > 0 ? high : Math.max(o, close);
  const l = Number.isFinite(low) && low > 0 ? low : Math.min(o, close);
  return { ts, open: o, high: Math.max(h, o, close), low: Math.min(l, o, close), close };
}

export function rowsToOhlc(rows: Row[]): Ohlc[] {
  const out: Ohlc[] = [];
  for (const row of rows) {
    const bar = toOhlc(row);
    if (bar) out.push(bar);
  }
  return out;
}

/**
 * `wanted` bars for one interval, oldest first. OKX answers newest first and
 * caps a page, so the live page comes back first and `history-candles` walks
 * back from the oldest bar in hand.
 */
export async function pullCandles(instId: string, tf: Timeframe, wanted: number): Promise<Ohlc[]> {
  const bar = okxBar(tf);
  const seen = new Map<number, Ohlc>();
  const live = await publicGet<Row>(
    `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(LIVE_PAGE, wanted)}`,
  );
  for (const c of rowsToOhlc(live)) seen.set(c.ts, c);

  // Bound the walk: a venue that stops paging must not hold up the first tick.
  for (let page = 0; page < 12 && seen.size < wanted; page++) {
    const oldest = Math.min(...seen.keys());
    if (!Number.isFinite(oldest)) break;
    const rows = await publicGet<Row>(
      `/api/v5/market/history-candles?instId=${instId}&bar=${bar}&after=${oldest}&limit=${HISTORY_PAGE}`,
    );
    const older = rowsToOhlc(rows);
    if (!older.length) break;
    for (const c of older) seen.set(c.ts, c);
  }
  return [...seen.values()].sort((a, b) => a.ts - b.ts).slice(-wanted);
}

/** ema200 needs 200 bars, so one page covers every higher interval. */
export async function pullCloses(instId: string, tf: HigherTf, bars: number): Promise<number[]> {
  const rows = await pullCandles(instId, tf, Math.min(bars, LIVE_PAGE));
  return rows.map((r) => r.close);
}
