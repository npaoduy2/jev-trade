import type { AssetCtx } from "../indicators";

export interface TickerRow {
  last?: string;
  open24h?: string;
  volCcy24h?: string;
  bidPx?: string;
  askPx?: string;
}
export interface MarkRow { markPx?: string }
export interface FundingRow { fundingRate?: string; premium?: string }
export interface OpenInterestRow { oiCcy?: string }
export interface IndexRow { idxPx?: string }

const num = (raw: unknown): number | null => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * OKX's venue context in the same shape Hyperliquid's `activeAssetCtx` arrives
 * in, so `venueFeatures` reads one set of fields whichever venue is running.
 *
 * `oiCcy` is open interest in coins, matching Hyperliquid's. `volCcy24h` is
 * 24h volume in coins, so the notional is that against the last trade.
 * OKX's index price is the oracle the mark is struck against.
 */
export function assetCtxFromOkx(parts: {
  ticker?: TickerRow | null;
  mark?: MarkRow | null;
  funding?: FundingRow | null;
  openInterest?: OpenInterestRow | null;
  index?: IndexRow | null;
}): AssetCtx {
  const last = num(parts.ticker?.last);
  const volCoins = num(parts.ticker?.volCcy24h);
  return {
    markPx: num(parts.mark?.markPx),
    oraclePx: num(parts.index?.idxPx),
    midPx: null,
    funding: num(parts.funding?.fundingRate),
    premium: num(parts.funding?.premium),
    openInterest: num(parts.openInterest?.oiCcy),
    prevDayPx: num(parts.ticker?.open24h),
    dayNtlVlm: volCoins != null && last != null ? volCoins * last : null,
  };
}
