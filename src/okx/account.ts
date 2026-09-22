import type { FillDir, FillPnlLike, VenueAccount } from "../account";
import type { VenueFillPrint } from "../venue";
import type { Side } from "../types";
import { toBase, type OkxInstrument } from "./instrument";

export interface BalanceRow {
  totalEq?: string;
  availEq?: string;
  details?: Array<{ ccy?: string; eq?: string; availEq?: string; availBal?: string; cashBal?: string }>;
}

export interface PositionRow {
  instId?: string;
  pos?: string;
  posSide?: string;
  avgPx?: string;
  upl?: string;
  lever?: string;
  liqPx?: string;
  markPx?: string;
}

const num = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Signed position in contracts. Net mode gives one row with a signed `pos`;
 * long/short mode gives a row per leg with `pos` always positive, so the side
 * has to come from `posSide`.
 */
export function netContracts(rows: PositionRow[], instId: string): number {
  let net = 0;
  for (const r of rows) {
    if (r.instId !== instId) continue;
    const p = num(r.pos);
    if (!Number.isFinite(p)) continue;
    net += r.posSide === "short" ? -Math.abs(p) : r.posSide === "long" ? Math.abs(p) : p;
  }
  return net;
}

/** The row carrying the live leg, so entry, leverage and liquidation read off one position. */
function livePosition(rows: PositionRow[], instId: string): PositionRow | undefined {
  const mine = rows.filter((r) => r.instId === instId && Math.abs(num(r.pos)) > 0);
  if (!mine.length) return rows.find((r) => r.instId === instId);
  return mine.reduce((a, b) => (Math.abs(num(b.pos)) > Math.abs(num(a.pos)) ? b : a));
}

/**
 * Position, mark PnL and equity from an OKX unified account. Realized and fees
 * come from fills, as they do on every venue here.
 *
 * `totalEq` is the whole cross-margin pool in USD and already carries unrealized
 * PnL, so it is the account equity. OKX has no separate perps wallet to hold
 * back, so `perpsValue` is that same pool rather than a slice of it.
 */
export function accountFromOkx(
  balance: BalanceRow | null,
  positions: PositionRow[],
  inst: OkxInstrument,
  settleCcy: string,
  prev?: VenueAccount | null,
): VenueAccount {
  const contracts = netContracts(positions, inst.id);
  const size = toBase(contracts, inst);
  const row = livePosition(positions, inst.id);
  const entry = num(row?.avgPx);
  const unreal = num(row?.upl);
  const lev = num(row?.lever);
  const liq = num(row?.liqPx);
  const detail = balance?.details?.find((d) => d.ccy === settleCcy);
  const accountValue = num(balance?.totalEq);
  const free = [detail?.availEq, detail?.availBal, balance?.availEq].map(num).find((n) => Number.isFinite(n));
  const equity = Number.isFinite(accountValue) ? accountValue : prev?.accountValue ?? 0;
  return {
    positionSz: size,
    entryPrice: size && Number.isFinite(entry) && entry > 0 ? entry : null,
    unrealizedUsd: Number.isFinite(unreal) ? unreal : 0,
    realizedUsd: prev?.realizedUsd ?? 0,
    feesUsd: prev?.feesUsd ?? 0,
    accountValue: equity,
    withdrawable: free ?? prev?.withdrawable ?? 0,
    perpsValue: equity,
    leverage: Number.isFinite(lev) && lev > 0 ? lev : prev?.leverage ?? null,
    liquidationPx: size && Number.isFinite(liq) && liq > 0 ? liq : null,
  };
}

/**
 * OKX bill subtypes on a fill: 3 open long, 4 open short, 5 close long,
 * 6 close short, and the 100s are liquidation and ADL closes.
 */
export function fillDirFromSubType(subType?: string): FillDir | undefined {
  const n = Number(subType);
  if (!Number.isFinite(n)) return undefined;
  if (n === 3 || n === 4) return "open";
  if (n === 5 || n === 6 || (n >= 100 && n <= 104)) return "close";
  return undefined;
}

export interface FillRow {
  instId?: string;
  ordId?: string;
  tradeId?: string;
  fillPx?: string;
  fillSz?: string;
  fillPnl?: string;
  /** This fill's fee, on the order stream. */
  fillFee?: string;
  /** Per fill on the REST fills feed, but the order's running total on the stream. */
  fee?: string;
  side?: string;
  subType?: string;
  fillTime?: string;
  ts?: string;
}

/**
 * One OKX fill, in coins and in this desk's signs. OKX writes a charged fee as
 * a negative number and a rebate as a positive one, the opposite of the ledger
 * here, so the sign flips exactly once, right here.
 *
 * `subType` only rides along on the REST fills feed. On the live order stream
 * the direction is read from realized PnL instead, which OKX books only when a
 * fill reduces a position. A fill that flips the side in one order books PnL
 * too, so it reads as a close rather than a flip.
 *
 * The order stream carries both `fillFee` for this fill and `fee` for the
 * order's running total, and a partial fill pushes once per piece. Reading the
 * running total would book the earlier pieces again, so this fill's own fee wins.
 */
export function okxFill(
  row: FillRow,
  inst: OkxInstrument,
  coin: string,
): { pnl: FillPnlLike; print: VenueFillPrint } | null {
  const tradeId = row.tradeId?.trim();
  const price = num(row.fillPx);
  const contracts = num(row.fillSz);
  if (!tradeId || !(price > 0) || !(Math.abs(contracts) > 0)) return null;
  const side: Side | null = row.side === "buy" ? "buy" : row.side === "sell" ? "sell" : null;
  if (!side) return null;
  const ts = num(row.fillTime) || num(row.ts) || Date.now();
  const closedPnl = num(row.fillPnl);
  const rawFee = row.fillFee != null && row.fillFee !== "" ? num(row.fillFee) : num(row.fee);
  const feeUsd = Number.isFinite(rawFee) ? -rawFee : 0;
  const realized = Number.isFinite(closedPnl) ? closedPnl : 0;
  const dir = fillDirFromSubType(row.subType) ?? (realized !== 0 ? "close" : "open");
  return {
    pnl: {
      coin,
      closedPnl: realized,
      fee: feeUsd,
      oid: row.ordId,
      tid: tradeId,
      time: ts,
      px: price,
      sz: toBase(Math.abs(contracts), inst),
      side,
    },
    print: {
      ts,
      side,
      price,
      size: toBase(Math.abs(contracts), inst),
      dir,
      closedPnl: realized,
      feeUsd,
    },
  };
}
