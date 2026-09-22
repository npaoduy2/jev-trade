import type { Level } from "../book";

/** `[price, size, liquidatedOrders, orderCount]`, size in contracts. */
export type RawLevel = [string, string, string, string] | string[];

/**
 * The `books` channel: one 400-level snapshot, then deltas. A level whose size
 * comes back "0" is gone. Every message chains `prevSeqId` to the last `seqId`,
 * so a broken chain means a message was lost and the book has to be re-seeded
 * rather than quietly drifting from the venue's.
 */
export class DepthBook {
  private bids = new Map<string, number>();
  private asks = new Map<string, number>();
  seqId = -1;
  ready = false;

  reset() {
    this.bids.clear();
    this.asks.clear();
    this.seqId = -1;
    this.ready = false;
  }

  snapshot(bids: RawLevel[], asks: RawLevel[], seqId = -1) {
    this.bids.clear();
    this.asks.clear();
    apply(this.bids, bids);
    apply(this.asks, asks);
    this.seqId = seqId;
    this.ready = true;
  }

  /** False when the chain broke. The caller re-snapshots. */
  update(bids: RawLevel[], asks: RawLevel[], seqId: number, prevSeqId: number): boolean {
    if (!this.ready) return false;
    // OKX repeats the last id when nothing changed on this push.
    if (seqId === this.seqId) return true;
    if (prevSeqId !== this.seqId) return false;
    apply(this.bids, bids);
    apply(this.asks, asks);
    this.seqId = seqId;
    return true;
  }

  /** Levels in coins, best first. `perContract` converts out of contracts. */
  levels(perContract: number, depth = 400): { bids: Level[]; asks: Level[] } {
    return {
      bids: side(this.bids, perContract, depth, (a, b) => b - a),
      asks: side(this.asks, perContract, depth, (a, b) => a - b),
    };
  }

  get size() {
    return this.bids.size + this.asks.size;
  }
}

function apply(book: Map<string, number>, rows: RawLevel[]) {
  for (const row of rows) {
    const px = row?.[0];
    if (typeof px !== "string") continue;
    const sz = Number(row[1]);
    if (!Number.isFinite(sz) || sz <= 0) book.delete(px);
    else book.set(px, sz);
  }
}

function side(
  book: Map<string, number>,
  perContract: number,
  depth: number,
  order: (a: number, b: number) => number,
): Level[] {
  const out: { px: number; sz: number }[] = [];
  for (const [px, sz] of book) {
    const p = Number(px);
    if (p > 0 && sz > 0) out.push({ px: p, sz: sz * perContract });
  }
  out.sort((a, b) => order(a.px, b.px));
  return out.slice(0, depth).map((l) => ({ px: String(l.px), sz: String(l.sz) }));
}
