import type { VenueAccount } from "./account";
import type { PriceGrid } from "./book";
import type { VenueChart } from "./chart";
import type { AssetCtx } from "./indicators";
import type { HigherTf } from "./timeframes";
import type { TradeFeed } from "./trades";
import type { Book, Fill, OrderId, PricePoint, Quote, Side } from "./types";

export type VenueName = "hyperliquid" | "okx";

export function isVenueName(raw: string | undefined): raw is VenueName {
  return raw === "hyperliquid" || raw === "okx";
}

/**
 * What one coin trades as on a venue. Hyperliquid names the perp after the coin
 * and derives the price grid from szDecimals; OKX names it `BTC-USDT-SWAP`,
 * states `tickSz`, and sizes orders in contracts of `ctVal` coins. Everything
 * above this line works in coin units on a grid, and never learns either rule.
 */
export interface Instrument {
  /** The venue's own id for the contract. */
  id: string;
  coin: string;
  grid: PriceGrid;
  /** Smallest size step, in coin units. */
  lotSz: number;
  /** Smallest order, in coin units. */
  minSz: number;
  /** Decimals a coin-unit size needs. Derived from `lotSz`. */
  sizeDecimals: number;
  maxLeverage: number;
}

/** A fill the venue reported on this account, in coin units. */
export interface VenueFillPrint {
  ts: number;
  side: Side;
  price: number;
  size: number;
  dir?: Fill["dir"];
  /** On-chain transaction, where the venue has one. A CEX does not. */
  hash?: string;
  closedPnl?: number;
  feeUsd?: number;
}

/**
 * Book, tape and candles for one coin, plus the tick clock the desk runs on.
 * The user stream lives behind the same object, but only the venue's own market
 * reads it, so it stays off this interface.
 */
export interface VenueFeed {
  readonly trades: TradeFeed;
  readonly chart: VenueChart;
  readonly assetCtx: AssetCtx | null;
  readonly book: Book | null;
  readonly tick: number;
  onPrice: ((book: Book) => void) | null;
  connect(): Promise<void>;
  start(onTick: (tick: number) => void): void;
}

/** Orders, position and collateral for one sleeve. */
export interface VenueMarket {
  readonly coin: string;
  readonly pair: string;
  readonly label: string;
  /** False in a dry run: real book, real decisions, simulated fills. */
  readonly liveKey: boolean;
  /** Wallet address, or the account label a CEX answers to. Null in a dry run. */
  readonly address: string | null;
  readonly margin: { usdc: number };
  readonly account: VenueAccount | null;
  readonly sizeDecimals: number;
  readonly maxLeverage: number;
  readonly takerFeeBps: number;
  readonly makerFeeBps: number;
  readonly assetCtx: AssetCtx | null;
  readonly chartPoints: PricePoint[];
  readonly fillPrints: VenueFillPrint[];
  onVenueFill: ((fill: VenueFillPrint) => void) | null;
  init(): Promise<void>;
  candleCloses(limit?: number): number[];
  tfCloses(tf: HigherTf): number[];
  refresh(): Promise<void>;
  readBook(): Book;
  quoteSize(mid: number, leverage?: number): number;
  setLeverage(raw: number): Promise<number>;
  send(
    side: Side,
    sizeSz: number,
    book: Book,
    cancel: OrderId[],
    reduceOnly?: boolean,
    taker?: boolean,
  ): Promise<Quote>;
  cancelResting(): Promise<OrderId[]>;
  cancelOpen(): Promise<OrderId[]>;
}

/** A sim fill carries a negative counter, never a venue handle. */
export function isVenueOrderId(id: OrderId): boolean {
  return typeof id === "string" ? id.length > 0 : id > 0;
}

/**
 * Whether a repeated stop signal means stop waiting on the venue. A process
 * manager can send the same signal twice in one breath, which is not a person
 * pressing again because the exit is taking too long.
 */
export function repeatMeansGiveUp(firstAt: number, now: number, graceMs = 1_000): boolean {
  return firstAt > 0 && now - firstAt >= graceMs;
}

/**
 * Pull every order this process left resting. Returns the ids it cancelled, or
 * null when the venue did not answer in time. One sleeve failing does not stop
 * the rest: a stuck cancel must not strand the others on the book.
 */
export async function pullResting(
  markets: { cancelOpen(): Promise<OrderId[]> }[],
  timeoutMs: number,
): Promise<OrderId[] | null> {
  const all = Promise.all(markets.map((m) => m.cancelOpen().catch(() => [] as OrderId[])));
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const done = await Promise.race([all, timeout]);
  return done == null ? null : done.flat();
}

/** Size step decimals. lotSz 0.001 => 3, lotSz 1 => 0. */
export function sizeDecimalsOfLot(lotSz: number): number {
  if (!Number.isFinite(lotSz) || lotSz <= 0) return 0;
  const s = String(lotSz);
  const exp = /e-(\d+)$/i.exec(s);
  if (exp) return Number(exp[1]);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Round a coin-unit size down onto the venue's lot grid. */
export function toLot(raw: number, inst: Pick<Instrument, "lotSz" | "sizeDecimals">): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const steps = Math.floor(raw / inst.lotSz + 1e-9);
  if (steps <= 0) return 0;
  return Number((steps * inst.lotSz).toFixed(inst.sizeDecimals));
}
