import { config } from "./config";
import { createModel } from "./model";
import { loadSleeves } from "./sleeves";
import { startServer, type SleeveView } from "./server";
import { Trader } from "./trader";
import type { BlockEvent, Book, Fill, Meta, Quote, Timing } from "./types";
import { pullResting, repeatMeansGiveUp, type VenueFillPrint, type VenueMarket } from "./venue";
import { createSleeve, isDryRun } from "./venues";

const specs = loadSleeves();
if (!specs.length) throw new Error("no sleeves");

const views: SleeveView[] = [];
const first = specs[0]!;
const meta: Meta = {
  model: config.model,
  wallet: null,
  dryRun: isDryRun(specs),
  market: first.pair,
  startedAt: Date.now(),
  venue: config.venue,
  coin: first.coin,
  pair: first.pair,
  explorerTx: config.explorerTx,
  tickMs: config.tickMs,
  sleeves: [],
};

let server: ReturnType<typeof startServer> | undefined;
const starters: Array<() => void> = [];
const markets: VenueMarket[] = [];
const desks: { market: VenueMarket; trader: Trader; label: string }[] = [];

for (const spec of specs) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { feed, market } = createSleeve(spec);
      feed.onPrice = (book: Book) => {
        server?.broadcastPrice(spec.coin, {
          ts: Date.now(),
          mid: book.mid,
          bestBid: book.bid,
          bestAsk: book.ask,
          spreadBps: book.spreadBps,
          markPx: feed.assetCtx?.markPx ?? null,
        });
      };
      await feed.connect();
      await market.init();
      const trader = new Trader(
        market,
        createModel(),
        onEvent(spec.coin),
        onFill(spec.coin),
        onQuote(spec.coin),
      );
      trader.attachTradeFeed(feed.trades);
      market.onVenueFill = (p: VenueFillPrint) => {
        server?.broadcastFill(spec.coin, 0, {
          side: p.side,
          size: p.size,
          price: p.price,
          txHash: p.hash ?? null,
          orderId: 0,
          simulated: false,
          dir: p.dir,
        }, p.ts);
      };
      markets.push(market);
      desks.push({ market, trader, label: spec.label });
      views.push({ coin: spec.coin, history: () => trader.history, tape: () => trader.tape });
      meta.sleeves.push({ coin: spec.coin, pair: spec.pair, label: spec.label, wallet: market.address });
      if (spec === first) {
        meta.wallet = market.address;
        meta.coin = spec.coin;
        meta.pair = spec.pair;
        meta.market = spec.pair;
      }
      starters.push(() => feed.start((tick: number) => trader.onBlock(tick)));
      console.log(`sleeve ${spec.label} ${spec.pair} ${market.liveKey ? market.address : "DRY RUN"}`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(1000 * (attempt + 1));
    }
  }
  if (lastErr) console.error(`sleeve ${spec.label} failed: ${(lastErr as Error).message}`);
}

if (!views.length) throw new Error("no sleeves started");

server = startServer(meta, views);

/**
 * Wait for the venue to answer before the first decision. A tick that runs on a
 * half-loaded account hands Jev a position it cannot see, and the desk cancels
 * every resting order on the way in, so there is nothing to lose by waiting.
 */
const SETTLE_TRIES = 10;
const SETTLE_WAIT_MS = 500;

for (const { market, trader, label } of desks) {
  if (!market.liveKey) continue;
  let account = market.account;
  for (let i = 0; i < SETTLE_TRIES && !account; i++) {
    await market.refresh().catch(() => {});
    account = market.account;
    if (!account) await Bun.sleep(SETTLE_WAIT_MS);
  }
  if (!account) {
    console.warn(`${label}: venue did not answer, starting without its position history`);
    continue;
  }
  trader.restore({
    nowMs: Date.now(),
    fills: market.fillPrints,
    positionSz: account.positionSz,
    entryPrice: account.entryPrice,
    closes: market.candleCloses(600),
  });
  const held = account.positionSz
    ? `${account.positionSz > 0 ? "long" : "short"} ${Math.abs(account.positionSz)} @ ${account.entryPrice}`
    : "flat";
  console.log(`${label} synced: ${held}, ${market.fillPrints.length} fills replayed`);
}

for (const start of starters) start();

console.log(`jev-trade ${config.venue} ${meta.sleeves.map((s) => s.label).join(" ")} model=${meta.model}${config.model === "jev" ? ` ${config.jevProvider}` : ""} tick ${config.tickMs}ms price ${config.priceMs}ms quote $${config.quoteUsd}/x cap $${config.maxNotionalUsd} :${config.port}`);

/** A resting entry outlives the process that placed it, so pull it on the way out. */
const SHUTDOWN_MS = 5_000;
let leavingAt = 0;

async function shutdown(signal: string) {
  const now = Date.now();
  if (leavingAt) {
    // Only a person pressing again, a moment later, means stop waiting.
    if (!repeatMeansGiveUp(leavingAt, now)) return;
    console.error(`${signal} again, leaving orders as they are`);
    process.exit(130);
  }
  leavingAt = now;
  console.log(`${signal}: pulling resting orders`);
  const pulled = await pullResting(markets, SHUTDOWN_MS);
  if (pulled == null) console.error(`shutdown: venue did not answer in ${SHUTDOWN_MS}ms, orders may still rest`);
  else console.log(`shutdown: pulled ${pulled.length} resting order${pulled.length === 1 ? "" : "s"}`);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

function onEvent(coin: string) {
  return (e: BlockEvent, t?: Timing) => {
    server?.broadcast(e);
    if (e.decision && !e.decision.late) {
      const d = e.decision;
      const q = e.quote;
      // A hold applies neither bias nor leverage, and an exit skips the leverage write.
      const lev = d.intent === "open" && d.leverage != null ? ` ${d.leverage}x` : "";
      const call = d.intent === "hold" ? "hold" : d.intent && d.bias ? `${d.intent} ${d.bias}${lev}` : d.action;
      const order = q && ` ${q.side.toUpperCase()} ${q.size} @ ${q.price}${q.taker ? " cross" : ""}${q.reduceOnly ? " reduce" : ""}${q.unchanged ? " unchanged" : q.status === "sim" ? " (sim)" : ` ${q.status}`}`;
      const quote = order || (d.intent === "hold" ? " NO ORDER" : "");
      console.log(`${coin} #${e.block} ${e.mid} ${call} ${d.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` loop ${t.loopMs}ms` : ""}`);
    }
  };
}

function onFill(coin: string) {
  return (block: number, fill: Fill) => {
    const kind = fill.dir === "open" ? "OPEN " : fill.dir === "close" ? "CLOSE " : fill.dir === "flip" ? "FLIP " : "";
    console.log(`${coin} #${block} ${kind}FILL ${fill.side} ${fill.size} @ ${fill.price}${fill.simulated ? " (sim)" : ""}`);
  };
}

function onQuote(coin: string) {
  return (block: number, quote: Quote) => {
    server?.broadcastQuote(coin, block, quote);
    if (quote.status !== "placed") console.log(`${coin} #${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price}`);
  };
}
