import { sameCoin } from "../sleeves";
import type { FillDir, VenueAccount } from "../account";

export interface ClearinghouseLike {
  withdrawable?: string;
  marginSummary?: { accountValue?: string };
  assetPositions?: Array<{
    position?: {
      coin?: string;
      szi?: string;
      entryPx?: string;
      unrealizedPnl?: string;
      leverage?: { type?: string; value?: number };
      /** Null while the position is flat. */
      liquidationPx?: string | null;
    };
  }>;
}

/**
 * Spot leg of a Hyperliquid wallet. Under unified margin this is the shared collateral
 * pool: USDC `total` is the account equity and `hold` is the part locked against perps.
 */
export interface SpotStateLike {
  balances?: Array<{ coin?: string; total?: string; hold?: string }>;
}

export interface SpotUsdc {
  total: number;
  hold: number;
}

/** USDC leg of `spotClearinghouseState`. `null` when the wallet holds no USDC. */
export function spotUsdc(state: SpotStateLike): SpotUsdc | null {
  const row = state.balances?.find((b) => b.coin === "USDC");
  if (!row) return null;
  const total = Number(row.total ?? Number.NaN);
  if (!Number.isFinite(total)) return null;
  const hold = Number(row.hold ?? 0);
  return { total, hold: Number.isFinite(hold) ? hold : 0 };
}

/** Hyperliquid `dir`: Open Long, Close Short, Long > Short, ... */
export function fillDir(dir?: string): FillDir | undefined {
  if (!dir) return undefined;
  const d = dir.toLowerCase();
  if (d.includes(">")) return "flip";
  if (d.includes("open")) return "open";
  if (d.includes("close")) return "close";
  return undefined;
}

/** Position, mark PnL and equity from Hyperliquid clearinghouseState. Realized/fees come from fills. */
export function accountFromClearinghouse(
  state: ClearinghouseLike,
  coin: string,
  prev?: VenueAccount | null,
  spot?: SpotUsdc | null,
): VenueAccount {
  const pos = state.assetPositions?.find((p) => sameCoin(p.position?.coin, coin))?.position;
  const szi = pos?.szi != null ? Number(pos.szi) : 0;
  const size = Number.isFinite(szi) ? szi : 0;
  const entry = pos?.entryPx != null ? Number(pos.entryPx) : NaN;
  const unreal = pos?.unrealizedPnl != null ? Number(pos.unrealizedPnl) : 0;
  const perpsValue = Number(state.marginSummary?.accountValue ?? 0);
  // Hyperliquid runs unified margin on testnet and mainnet alike: spot USDC is the one
  // collateral pool and already carries perps PnL, so it is the account equity.
  // marginSummary.accountValue is only the perps slice and reads far too small once a
  // position draws on spot. No spot USDC means there is nothing to unify with.
  const unified = spot && Number.isFinite(spot.total) ? spot : null;
  const accountValue = unified ? unified.total : perpsValue;
  const withdrawable = unified ? unified.total - unified.hold : Number(state.withdrawable ?? 0);
  const lev = pos?.leverage?.value != null ? Number(pos.leverage.value) : NaN;
  const liq = pos?.liquidationPx != null ? Number(pos.liquidationPx) : NaN;
  return {
    positionSz: size,
    entryPrice: size && Number.isFinite(entry) ? entry : null,
    unrealizedUsd: Number.isFinite(unreal) ? unreal : 0,
    realizedUsd: prev?.realizedUsd ?? 0,
    feesUsd: prev?.feesUsd ?? 0,
    accountValue: Number.isFinite(accountValue) ? accountValue : 0,
    withdrawable: Number.isFinite(withdrawable) ? withdrawable : 0,
    perpsValue: Number.isFinite(perpsValue) ? perpsValue : 0,
    leverage: Number.isFinite(lev) && lev > 0 ? lev : prev?.leverage ?? null,
    liquidationPx: size && Number.isFinite(liq) && liq > 0 ? liq : null,
  };
}
