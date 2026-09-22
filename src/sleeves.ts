import { existsSync, readFileSync } from "node:fs";
import { config, hexKey, resolveCoins, type OkxCredentials } from "./config";
import type { VenueName } from "./venue";

/**
 * What the venue calls the contract for one coin. Hyperliquid names its perp
 * after the coin; OKX names the USDT-margined swap `BTC-USDT-SWAP`.
 */
export function coinPair(coin: string, venue: VenueName = config.venue, quoteCcy = config.okxQuoteCcy): string {
  return venue === "okx" ? `${coin}-${quoteCcy}-SWAP` : `${coin}-USD`;
}

export function sameCoin(a: string | undefined, b: string): boolean {
  return !!a && a === b;
}

export interface SleeveConfig {
  coin: string;
  pair: string;
  label: string;
  /** Hyperliquid signer. Absent means a dry run for that sleeve. */
  privateKey?: string;
  /** OKX key set. One key backs every sleeve, as one account holds every position. */
  okx?: OkxCredentials;
}

type WalletFile = { sleeves?: { coin?: string; privateKey?: string }[] };

/** Parse `.wallets.json` or `WALLETS_JSON`. Env overlays the file. */
export function parseWalletsJson(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed = JSON.parse(raw) as WalletFile | Record<string, string>;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as WalletFile).sleeves)) {
      for (const s of (parsed as WalletFile).sleeves ?? []) {
        if (s.coin && s.privateKey) out.set(s.coin, s.privateKey);
      }
      return out;
    }
    if (parsed && typeof parsed === "object") {
      for (const [coin, key] of Object.entries(parsed as Record<string, string>)) {
        if (coin && typeof key === "string" && key) out.set(coin, key);
      }
    }
  } catch {
    // ignore junk
  }
  return out;
}

function loadWalletKeys(): Map<string, string> {
  const out = new Map<string, string>();
  if (existsSync(".wallets.json")) {
    try {
      for (const [coin, key] of parseWalletsJson(readFileSync(".wallets.json", "utf8"))) {
        out.set(coin, key);
      }
    } catch {
      // ignore junk
    }
  }
  const fromEnv = process.env.WALLETS_JSON;
  if (fromEnv) {
    for (const [coin, key] of parseWalletsJson(fromEnv)) out.set(coin, key);
  }
  return out;
}

/**
 * One account holds a position in every perp at once, so one key set backs all
 * the listed coins. On Hyperliquid a per-coin key in WALLETS_JSON or
 * `.wallets.json` overrides PRIVATE_KEY for that coin.
 */
export function loadSleeves(venue: VenueName = config.venue): SleeveConfig[] {
  const listed = resolveCoins(process.env);
  if (venue === "okx") {
    const okx = config.okx ?? undefined;
    return listed.map((coin) => ({ coin, pair: coinPair(coin, venue), label: coin, okx }));
  }
  const file = loadWalletKeys();
  const source = process.env.PRIVATE_KEY;
  return listed.map((coin) => {
    const fromFile = file.get(coin);
    const privateKey = fromFile ?? source;
    return {
      coin,
      pair: coinPair(coin, venue),
      label: coin,
      privateKey: privateKey ? hexKey(privateKey) : undefined,
    };
  });
}
