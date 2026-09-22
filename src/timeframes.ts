import { config } from "./config";

const INFO_URL = (testnet: boolean) =>
  testnet ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info";

/** Pulled over REST. 1m already arrives live on the candle socket. */
export const HIGHER_TFS = ["15m", "1h", "4h", "1d"] as const;
export type HigherTf = (typeof HIGHER_TFS)[number];
export type Timeframe = "1m" | HigherTf;
export const TIMEFRAMES: Timeframe[] = ["1m", ...HIGHER_TFS];

const BAR_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** The venue caps a candleSnapshot near this, which is enough for an ema200. */
const BARS = 500;
const REFRESH_MS = 5 * 60_000;

/**
 * Closes per venue interval, deliberately outside `VenueChart`. The dashboard
 * series only knows 1s/1m/15m bars, and `candleBar` relabels anything else as
 * 1m, so an hourly candle in that series would corrupt the chart.
 */
export class Timeframes {
  private closes = new Map<HigherTf, number[]>();
  private pulledAt = new Map<HigherTf, number>();

  series(tf: HigherTf): number[] {
    return this.closes.get(tf) ?? [];
  }

  /** Bars held per interval. Used by the startup banner and by tests. */
  get depth(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const tf of HIGHER_TFS) out[tf] = this.series(tf).length;
    return out;
  }

  async refresh(coin: string, now = Date.now()): Promise<void> {
    const due = HIGHER_TFS.filter((tf) => now - (this.pulledAt.get(tf) ?? 0) >= REFRESH_MS);
    await Promise.all(due.map((tf) => this.pull(coin, tf, now)));
  }

  private async pull(coin: string, tf: HigherTf, now: number): Promise<void> {
    try {
      const res = await fetch(INFO_URL(config.hlTestnet), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "candleSnapshot",
          req: { coin, interval: tf, startTime: now - BARS * BAR_MS[tf], endTime: now },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as unknown;
      if (!Array.isArray(rows)) return;
      const closes: number[] = [];
      for (const row of rows) {
        const c = Number((row as { c?: unknown })?.c);
        if (Number.isFinite(c) && c > 0) closes.push(c);
      }
      // A short answer is still better than dropping the series entirely.
      if (closes.length) this.closes.set(tf, closes);
      this.pulledAt.set(tf, now);
    } catch (e) {
      // Keep the last good series. A stale higher timeframe beats a null one.
      console.warn(`${coin} ${tf} candles: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}
