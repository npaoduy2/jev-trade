import { gridFromTick } from "../book";
import { sizeDecimalsOfLot, type Instrument } from "../venue";
import { publicGet } from "./rest";

/**
 * An OKX swap, plus the contract rule the rest of the desk must never see. OKX
 * sizes a swap order in contracts of `ctVal` coins, and reports book depth,
 * tape prints and open position in contracts too. Everything above the venue
 * works in coins, so every size crosses this boundary exactly once.
 */
export interface OkxInstrument extends Instrument {
  /** Coins in one contract, `ctVal * ctMult`. */
  coinsPerContract: number;
  /** Contract step and floor, as OKX states them. */
  ctLot: number;
  ctMin: number;
  ctDecimals: number;
}

interface InstrumentRow {
  instId?: string;
  tickSz?: string;
  lotSz?: string;
  minSz?: string;
  ctVal?: string;
  ctMult?: string;
  ctValCcy?: string;
  ctType?: string;
  settleCcy?: string;
  lever?: string;
  state?: string;
}

const pos = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function instrumentFromRow(row: InstrumentRow, coin: string): OkxInstrument {
  const instId = row.instId ?? "";
  const coinsPerContract = pos(row.ctVal, 1) * pos(row.ctMult, 1);
  const ctLot = pos(row.lotSz, 1);
  const ctMin = pos(row.minSz, ctLot);
  const lotSz = coinsPerContract * ctLot;
  return {
    id: instId,
    coin,
    grid: gridFromTick(pos(row.tickSz, 1e-6)),
    lotSz,
    minSz: coinsPerContract * ctMin,
    sizeDecimals: sizeDecimalsOfLot(lotSz),
    maxLeverage: Math.max(1, Math.floor(pos(row.lever, 10))),
    coinsPerContract,
    ctLot,
    ctMin,
    ctDecimals: sizeDecimalsOfLot(ctLot),
  };
}

export async function loadInstrument(instId: string, coin: string): Promise<OkxInstrument> {
  const rows = await publicGet<InstrumentRow>(`/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  const row = rows.find((r) => r.instId === instId);
  if (!row) throw new Error(`unknown OKX swap ${instId}`);
  if (row.state && row.state !== "live") throw new Error(`OKX swap ${instId} is ${row.state}, not live`);
  if (row.ctType && row.ctType !== "linear") {
    throw new Error(`OKX swap ${instId} is ${row.ctType}; this desk margins and books PnL in ${row.settleCcy ?? "the quote currency"}, which needs a linear contract`);
  }
  return instrumentFromRow(row, coin);
}

/** Coins to contracts, rounded down onto the contract grid. */
export function toContracts(baseSz: number, inst: OkxInstrument): number {
  if (!Number.isFinite(baseSz) || baseSz <= 0) return 0;
  const raw = baseSz / inst.coinsPerContract;
  const steps = Math.floor(raw / inst.ctLot + 1e-9);
  if (steps <= 0) return 0;
  return Number((steps * inst.ctLot).toFixed(inst.ctDecimals));
}

/** Contracts to coins. Signed: OKX reports a short position as a negative `pos`. */
export function toBase(contracts: number, inst: OkxInstrument): number {
  const n = Number(contracts);
  if (!Number.isFinite(n)) return 0;
  return Number((n * inst.coinsPerContract).toFixed(inst.sizeDecimals + 2));
}

/**
 * Contracts for one order, or 0 when the venue would reject it outright.
 *
 * `minSz` is a floor on opening exposure. A reduce is exempt: whatever is open
 * has to stay closable, including a remainder left under one minimum order.
 */
export function orderContracts(baseSz: number, inst: OkxInstrument, reduceOnly: boolean): number {
  const contracts = toContracts(baseSz, inst);
  if (contracts <= 0) return 0;
  if (!reduceOnly && contracts < inst.ctMin - 1e-9) return 0;
  return contracts;
}

export function formatContracts(contracts: number, inst: OkxInstrument): string {
  return contracts.toFixed(inst.ctDecimals);
}

export function formatPx(px: number, inst: OkxInstrument): string {
  return px.toFixed(inst.grid.decimals);
}
