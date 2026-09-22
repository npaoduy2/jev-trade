import type { BlockEvent } from "./bot-types";

export type SleevePnl = {
  coin: string;
  unrealized: number;
  realized: number;
  open: boolean;
};

export function sleevePnl(latest: BlockEvent | null | undefined, mark?: number | null): SleevePnl {
  const pos = latest?.position;
  const open = Boolean(pos && pos.side !== "flat" && pos.size > 0);
  const reported = open && typeof pos?.unrealizedUsd === "number" && Number.isFinite(pos.unrealizedUsd)
    ? pos.unrealizedUsd
    : 0;
  // Reprice only against a live mark. Without one, the venue's own figure stands.
  const unrealized = open && mark != null && mark > 0 ? unrealizedAt(pos, mark) : reported;
  const realized = typeof latest?.totals?.realizedUsd === "number" && Number.isFinite(latest.totals.realizedUsd)
    ? latest.totals.realizedUsd
    : 0;
  return { coin: latest?.coin ?? "", unrealized, realized, open };
}

export function portfolioPnl(
  latestByCoin: Record<string, BlockEvent | null | undefined>,
  markByCoin?: Record<string, { mid: number; markPx?: number | null } | null | undefined>,
): {
  unrealized: number;
  realized: number;
} {
  let unrealized = 0;
  let realized = 0;
  for (const [coin, latest] of Object.entries(latestByCoin)) {
    const live = markByCoin?.[coin];
    const row = sleevePnl(latest, live?.markPx ?? live?.mid ?? null);
    unrealized += row.unrealized;
    realized += row.realized;
  }
  return { unrealized, realized };
}

/**
 * Hyperliquid equity across the wallets behind the sleeves, counting each wallet
 * once. Sleeves sharing one account all report that account's equity, so adding
 * them up multiplies the balance by the number of coins.
 */
export function portfolioBalance(
  latestByCoin: Record<string, BlockEvent | null | undefined>,
  walletByCoin?: Record<string, string | null | undefined>,
): number | null {
  let sum = 0;
  let any = false;
  const counted = new Set<string>();
  for (const [coin, latest] of Object.entries(latestByCoin)) {
    const v = latest?.accountValue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const wallet = walletByCoin?.[coin];
    if (wallet) {
      if (counted.has(wallet)) continue;
      counted.add(wallet);
    }
    sum += v;
    any = true;
  }
  return any ? sum : null;
}

/** Unrealized as a percent of initial margin, when size, entry, and leverage exist. */
export function roePct(pos: {
  side: string;
  size: number;
  entryPrice: number | null;
  leverage: number | null;
  unrealizedUsd: number;
} | null | undefined): number | null {
  if (!pos || pos.side === "flat" || !(pos.size > 0) || !(pos.entryPrice && pos.entryPrice > 0)) return null;
  const lev = pos.leverage && pos.leverage > 0 ? pos.leverage : 1;
  const margin = (pos.size * pos.entryPrice) / lev;
  if (!(margin > 0)) return null;
  return pos.unrealizedUsd / margin;
}

/**
 * Unrealized at a given price, by the venue's own arithmetic. Prefer the venue's
 * mark: it is what prices PnL and liquidation there, and it is not the mid. The
 * per-tick figure on a BlockEvent is a minute old at a 60s tick, while the price
 * beside it moves every 200ms.
 */
export function unrealizedAt(
  pos: {
    side: string;
    size: number;
    entryPrice: number | null;
    unrealizedUsd: number;
  } | null | undefined,
  price: number | null | undefined,
): number {
  if (!pos || pos.side === "flat" || !(pos.size > 0)) return 0;
  if (!pos.entryPrice || !(pos.entryPrice > 0) || !price || !(price > 0)) return pos.unrealizedUsd;
  const move = price - pos.entryPrice;
  return pos.size * (pos.side === "short" ? -move : move);
}
