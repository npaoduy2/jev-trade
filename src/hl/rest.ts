import { config } from "../config";
import type { Ohlc } from "../chart";
import { candleOhlc } from "../chart";

export const INFO_URL = () =>
  config.hlTestnet ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info";

export const WS_URL = () =>
  config.hlTestnet ? "wss://api.hyperliquid-testnet.xyz/ws" : "wss://api.hyperliquid.xyz/ws";

/** One `info` call. Throws on a non-2xx so callers can keep their last good state. */
export async function info<T>(body: unknown): Promise<T> {
  const res = await fetch(INFO_URL(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hl ${(body as { type?: string })?.type ?? "info"} HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Candles for one interval, oldest first. The venue caps the answer near 500. */
export async function candles(coin: string, interval: string, startTime: number, endTime: number): Promise<Ohlc[]> {
  const rows = await info<unknown>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
  if (!Array.isArray(rows)) return [];
  const out: Ohlc[] = [];
  for (const row of rows) {
    const bar = row && typeof row === "object" ? candleOhlc(row as Record<string, unknown>) : null;
    if (bar) out.push(bar);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
