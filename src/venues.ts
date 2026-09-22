import { config } from "./config";
import type { SleeveConfig } from "./sleeves";
import type { VenueFeed, VenueMarket } from "./venue";
import { HlFeed } from "./hl/feed";
import { HlMarket } from "./hl/market";
import { OkxFeed } from "./okx/feed";
import { OkxMarket } from "./okx/market";

export interface Sleeve {
  feed: VenueFeed;
  market: VenueMarket;
}

/**
 * One coin on the configured venue. The feed and the market of a venue are a
 * pair: the market reads the user stream the feed holds open, so they are only
 * ever built together.
 */
export function createSleeve(spec: SleeveConfig): Sleeve {
  if (config.venue === "okx") {
    const feed = new OkxFeed(spec.coin, spec.pair);
    return { feed, market: new OkxMarket(feed, spec) };
  }
  const feed = new HlFeed(spec.coin);
  return { feed, market: new HlMarket(feed, spec) };
}

/** No key for any sleeve means a dry run: real book, real decisions, simulated fills. */
export function isDryRun(specs: SleeveConfig[]): boolean {
  if (config.dryRun) return true;
  return config.venue === "okx" ? !config.okx : specs.every((s) => !s.privateKey);
}
