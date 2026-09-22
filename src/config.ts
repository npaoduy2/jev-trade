import { isVenueName, type VenueName } from "./venue";

const env = (key: string, fallback?: string) => process.env[key] ?? fallback;

/** Anything shaped like `process.env`. Named keys stay documented at each reader. */
export type Env = Record<string, string | undefined>;

export function resolveVenue(e: Env): VenueName {
  const raw = e.VENUE?.trim().toLowerCase();
  if (!raw) return "hyperliquid";
  if (isVenueName(raw)) return raw;
  throw new Error("VENUE must be hyperliquid or okx");
}

/** The coins to run, from the venue-neutral name first, then the old one. */
export function resolveCoins(e: Env): string[] {
  const raw = e.COINS?.trim() || e.HL_COINS?.trim() || "BTC,ETH,SOL,DOGE,BNB";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export interface OkxCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

/** All three or nothing. A half-filled key set would fail on the first signed call. */
export function resolveOkxCredentials(e: Env): OkxCredentials | null {
  const apiKey = e.OKX_API_KEY?.trim() ?? "";
  const secret = e.OKX_API_SECRET?.trim() ?? "";
  const passphrase = e.OKX_PASSPHRASE?.trim() ?? "";
  if (!apiKey && !secret && !passphrase) return null;
  if (!apiKey || !secret || !passphrase) {
    throw new Error("OKX needs OKX_API_KEY, OKX_API_SECRET and OKX_PASSPHRASE together. Leave all three empty for a dry run.");
  }
  return { apiKey, secret, passphrase };
}

export type JevProvider = "typesafe" | "gateway";

export function resolveJevProvider(e: Env): JevProvider {
  const explicit = e.JEV_PROVIDER?.trim().toLowerCase();
  if (explicit === "typesafe" || explicit === "gateway") return explicit;
  if (explicit) throw new Error("JEV_PROVIDER must be typesafe or gateway");
  if (e.TYPESAFE_API_KEY?.trim()) return "typesafe";
  if (e.AI_GATEWAY_API_KEY?.trim()) return "gateway";
  return "typesafe";
}

export function resolveJevModelId(e: Env, provider: JevProvider): string {
  const set = e.JEV_MODEL_ID?.trim();
  if (set) return set;
  return provider === "gateway" ? "typesafe-ai/jev" : "jev-latest";
}

export function assertJevCredentials(model: string, provider: JevProvider, e: Env): void {
  if (model !== "jev") return;
  if (provider === "typesafe" && !e.TYPESAFE_API_KEY?.trim()) {
    throw new Error("MODEL=jev with JEV_PROVIDER=typesafe needs TYPESAFE_API_KEY. Get a key at https://docs.typesafe.ai/ or set JEV_PROVIDER=gateway with AI_GATEWAY_API_KEY.");
  }
  if (provider === "gateway" && !e.AI_GATEWAY_API_KEY?.trim()) {
    throw new Error("MODEL=jev with JEV_PROVIDER=gateway needs AI_GATEWAY_API_KEY. Or set JEV_PROVIDER=typesafe with TYPESAFE_API_KEY.");
  }
}

const venue = resolveVenue(process.env);
const hlTestnet = env("HL_TESTNET", "true") !== "false";
// OKX demo trading, the testnet equivalent: same API, simulated balances.
const okxDemo = env("OKX_DEMO", "true") !== "false";
const tickMs = Number(env("TICK_MS", "60000"));
// Half a tick, clamped, so one slow answer costs at most the tick it runs in.
const jevDeadlineMs = Number(env("JEV_DEADLINE_MS", "")) || Math.max(4_000, Math.min(20_000, Math.round(tickMs / 2)));
const jevProvider = resolveJevProvider(process.env);
const jevModelId = resolveJevModelId(process.env, jevProvider);

export const config = {
  venue,
  hlTestnet,
  okxDemo,
  /** Settlement currency of the OKX perp. `BTC` + `USDT` => `BTC-USDT-SWAP`. */
  okxQuoteCcy: env("OKX_QUOTE_CCY", "USDT")!.trim().toUpperCase(),
  okx: resolveOkxCredentials(process.env),
  tickMs,
  /** How long Jev has to answer one tick before the tick is marked late. */
  jevDeadlineMs,
  /** Book/price prints for the chart. Independent of Jev ticks. */
  priceMs: Math.max(50, Number(env("PRICE_MS", "200"))),
  // A CEX books fills in its own ledger, so there is no per-fill page to link.
  explorerTx: venue === "okx"
    ? ""
    : hlTestnet
      ? "https://app.hyperliquid-testnet.xyz/explorer/tx/"
      : "https://app.hyperliquid.xyz/explorer/tx/",
  privateKey: env("PRIVATE_KEY"),
  dryRun: env("DRY_RUN") === "true",
  /** Notional of one quote at 1x. Jev's leverage rung scales it from here. */
  quoteUsd: Number(env("QUOTE_USD", "40")),
  /** Safety valve on the scaled notional. Does not bind at the default ladder. */
  maxNotionalUsd: Number(env("MAX_NOTIONAL_USD", "1000")),
  quoteInsideTicks: Number(env("QUOTE_INSIDE_TICKS", "1")),
  /** How far an Ioc exit crosses the touch so it fills on the spot. */
  closeSlippageBps: Number(env("CLOSE_SLIPPAGE_BPS", "25")),
  horizonBlocks: Number(env("HORIZON_BLOCKS", "100")),
  model: env("MODEL", "mock") as "mock" | "jev",
  /** typesafe = official TypeSafe API. gateway = Vercel AI Gateway. */
  jevProvider,
  jevModelId,
  jevUsdPerMTok: 0.042,
  port: Number(env("PORT", "3000")),
  historySize: 1000,
  bankrollUsd: Number(env("BANKROLL_USD", "200")),
};

export function hexKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}
