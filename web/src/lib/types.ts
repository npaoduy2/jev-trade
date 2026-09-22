export type {
  BlockEvent,
  Fill,
  Meta,
  PricePoint,
  Quote,
  SleeveMeta,
} from "./bot-types";
import type { BlockEvent, Meta, PricePoint } from "./bot-types";

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface SleeveFeed {
  events: BlockEvent[];
  tape: PricePoint[];
  latest: BlockEvent | null;
  avgLatencyMs: number;
  /** Newest touch off the price stream, between the once-a-tick block events. */
  mark?: { ts: number; mid: number; bestBid: number; bestAsk: number; spreadBps: number; markPx?: number | null } | null;
}

export interface FeedState {
  meta: Meta | null;
  connection: ConnectionState;
  byCoin: Record<string, SleeveFeed>;
}
