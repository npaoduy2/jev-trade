import { sameCoin } from "./sleeves";

export interface VenueAccount {
  /** Signed base size. Positive = long, negative = short. */
  positionSz: number;
  entryPrice: number | null;
  unrealizedUsd: number;
  realizedUsd: number;
  feesUsd: number;
  /** Unified account equity: the whole USDC collateral pool behind this account. */
  accountValue: number;
  /** Collateral not locked against an open position. */
  withdrawable: number;
  /** Perps wallet on its own. Only a slice of `accountValue` once a position draws on spot. */
  perpsValue: number;
  leverage: number | null;
  liquidationPx: number | null;
}

export const emptyAccount = (): VenueAccount => ({
  positionSz: 0,
  entryPrice: null,
  unrealizedUsd: 0,
  realizedUsd: 0,
  feesUsd: 0,
  accountValue: 0,
  withdrawable: 0,
  perpsValue: 0,
  leverage: null,
  liquidationPx: null,
});

/**
 * One fill as the venue reported it. `closedPnl` and `fee` are signed the way a
 * desk reads them: realized PnL as booked, fee positive when it was charged.
 */
export interface FillPnlLike {
  coin?: string;
  closedPnl?: string | number;
  fee?: string | number;
  hash?: string;
  tid?: number | string;
  oid?: number | string;
  time?: number;
  px?: string | number;
  sz?: string | number;
  side?: string;
  dir?: string;
}

export type FillDir = "open" | "close" | "flip";

export function fillKey(f: FillPnlLike): string {
  if (f.hash != null && f.tid != null) return `${f.hash}:${f.tid}`;
  if (f.oid != null && f.tid != null) return `${f.oid}:${f.tid}`;
  return `${f.hash ?? ""}:${f.oid ?? ""}:${f.closedPnl ?? ""}:${f.fee ?? ""}`;
}

export class FillPnlBook {
  realized = 0;
  fees = 0;
  private seen = new Set<string>();

  add(fill: FillPnlLike, coin: string): boolean {
    if (fill.coin != null && !sameCoin(fill.coin, coin)) return false;
    const key = fillKey(fill);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const closed = Number(fill.closedPnl ?? 0);
    const fee = Number(fill.fee ?? 0);
    if (Number.isFinite(closed)) this.realized += closed;
    if (Number.isFinite(fee)) this.fees += fee;
    return true;
  }

  apply(account: VenueAccount): VenueAccount {
    return { ...account, realizedUsd: this.realized, feesUsd: this.fees };
  }
}
