/** Pulled over REST. 1m already arrives live on the candle socket. */
export const HIGHER_TFS = ["15m", "1h", "4h", "1d"] as const;
export type HigherTf = (typeof HIGHER_TFS)[number];
export type Timeframe = "1m" | HigherTf;
export const TIMEFRAMES: Timeframe[] = ["1m", ...HIGHER_TFS];

export const BAR_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Venues cap one candle request near this, which is enough for an ema200. */
export const BARS = 500;
const REFRESH_MS = 5 * 60_000;
/** Gap between interval pulls, so one sleeve's refresh is not a burst. */
const STAGGER_MS = 150;

/** Closes for one interval, oldest first. The venue owns the request. */
export type ClosePuller = (tf: HigherTf, bars: number, now: number) => Promise<number[]>;

/**
 * Closes per venue interval, deliberately outside `VenueChart`. The dashboard
 * series only knows 1s/1m/15m bars, and `candleBar` relabels anything else as
 * 1m, so an hourly candle in that series would corrupt the chart.
 */
export class Timeframes {
  private closes = new Map<HigherTf, number[]>();
  private pulledAt = new Map<HigherTf, number>();

  constructor(private pull: ClosePuller) {}

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
    // One at a time. Four intervals per sleeve, fired together across every
    // sleeve, is a burst the venue answers with 429 and a sleeve that never
    // starts. Higher timeframes move slowly; none of this is urgent.
    for (const tf of due) {
      await this.pullOne(coin, tf, now);
      await Bun.sleep(STAGGER_MS);
    }
  }

  private async pullOne(coin: string, tf: HigherTf, now: number): Promise<void> {
    try {
      const closes = await this.pull(tf, BARS, now);
      // A short answer is still better than dropping the series entirely.
      if (closes.length) this.closes.set(tf, closes);
      this.pulledAt.set(tf, now);
    } catch (e) {
      // Keep the last good series. A stale higher timeframe beats a null one.
      console.warn(`${coin} ${tf} candles: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}
