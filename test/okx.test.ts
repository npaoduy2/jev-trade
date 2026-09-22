import { expect, test } from "bun:test";
import { accountFromOkx, fillDirFromSubType, netContracts, okxFill } from "../src/okx/account";
import { okxBar, rowsToOhlc } from "../src/okx/candles";
import { assetCtxFromOkx } from "../src/okx/context";
import { DepthBook } from "../src/okx/depth";
import { formatContracts, formatPx, instrumentFromRow, orderContracts, toBase, toContracts } from "../src/okx/instrument";
import { signature, wsLogin } from "../src/okx/rest";
import { toLot } from "../src/venue";

const btc = instrumentFromRow(
  { instId: "BTC-USDT-SWAP", tickSz: "0.1", lotSz: "0.01", minSz: "0.01", ctVal: "0.01", ctMult: "1", lever: "100" },
  "BTC",
);
const doge = instrumentFromRow(
  { instId: "DOGE-USDT-SWAP", tickSz: "0.00001", lotSz: "0.1", minSz: "1", ctVal: "1000", ctMult: "1", lever: "75" },
  "DOGE",
);

test("an OKX swap states its own grid instead of deriving one", () => {
  expect(btc.grid).toEqual({ tick: 0.1, decimals: 1 });
  expect(btc.lotSz).toBeCloseTo(0.0001, 12);
  expect(btc.sizeDecimals).toBe(4);
  expect(btc.maxLeverage).toBe(100);
  // ctVal 1000 makes one DOGE contract 1000 coins, so the floor is 1000 coins.
  expect(doge.minSz).toBe(1000);
  expect(doge.lotSz).toBe(100);
});

test("coins and contracts round-trip, so a reduceOnly close leaves no dust", () => {
  for (const coins of [0.0047, 0.01, 0.1234, 1.5]) {
    const onGrid = toLot(coins, btc);
    expect(toBase(toContracts(onGrid, btc), btc)).toBeCloseTo(onGrid, 10);
  }
  expect(toContracts(0.0047, btc)).toBeCloseTo(0.47, 10);
  expect(toBase(-0.47, btc)).toBeCloseTo(-0.0047, 10);
});

test("an entry under the venue floor sends nothing, but a reduce still clears", () => {
  expect(toContracts(0.00005, btc)).toBe(0);
  // 500 DOGE is half a contract: on the lot grid, but under minSz of one.
  expect(toContracts(500, doge)).toBeCloseTo(0.5, 10);
  expect(orderContracts(500, doge, false)).toBe(0);
  // Whatever is open has to stay closable, floor or no floor.
  expect(orderContracts(500, doge, true)).toBeCloseTo(0.5, 10);
  expect(orderContracts(0.00005, btc, true)).toBe(0);
  expect(formatContracts(orderContracts(0.0047, btc, false), btc)).toBe("0.47");
  expect(formatPx(85253.27, btc)).toBe("85253.3");
});

test("the books channel merges deltas and refuses a broken chain", () => {
  const book = new DepthBook();
  book.snapshot([["100", "2", "0", "1"], ["99", "3", "0", "1"]], [["101", "1", "0", "1"]], 10);
  expect(book.levels(0.01).bids).toEqual([{ px: "100", sz: "0.02" }, { px: "99", sz: "0.03" }]);
  // A level that comes back at size 0 is gone, not a zero-size level.
  expect(book.update([["100", "0", "0", "0"], ["98", "5", "0", "1"]], [], 11, 10)).toBe(true);
  expect(book.levels(0.01).bids).toEqual([{ px: "99", sz: "0.03" }, { px: "98", sz: "0.05" }]);
  // A lost message leaves a book that no longer matches the venue's.
  expect(book.update([], [], 13, 12)).toBe(false);
  // OKX repeats the last id when nothing changed.
  expect(book.update([], [], 11, 10)).toBe(true);
  book.reset();
  expect(book.update([], [], 12, 11)).toBe(false);
});

test("net mode and long/short mode both read as one signed position", () => {
  expect(netContracts([{ instId: "BTC-USDT-SWAP", pos: "-0.47", posSide: "net" }], "BTC-USDT-SWAP")).toBeCloseTo(-0.47, 10);
  expect(
    netContracts(
      [
        { instId: "BTC-USDT-SWAP", pos: "1.2", posSide: "long" },
        { instId: "BTC-USDT-SWAP", pos: "0.5", posSide: "short" },
        { instId: "ETH-USDT-SWAP", pos: "9", posSide: "long" },
      ],
      "BTC-USDT-SWAP",
    ),
  ).toBeCloseTo(0.7, 10);
});

test("equity is the whole unified pool, and the position comes back in coins", () => {
  const a = accountFromOkx(
    { totalEq: "548.20", details: [{ ccy: "USDT", eq: "548.20", availEq: "546.14", availBal: "500" }] },
    [{ instId: "BTC-USDT-SWAP", pos: "-0.47", posSide: "net", avgPx: "77180", upl: "-1.23", lever: "3", liqPx: "82000" }],
    btc,
    "USDT",
  );
  expect(a.positionSz).toBeCloseTo(-0.0047, 10);
  expect(a.entryPrice).toBe(77180);
  expect(a.unrealizedUsd).toBe(-1.23);
  expect(a.accountValue).toBe(548.2);
  expect(a.withdrawable).toBe(546.14);
  // OKX has no separate perps wallet to hold back from the pool.
  expect(a.perpsValue).toBe(548.2);
  expect(a.leverage).toBe(3);
  expect(a.liquidationPx).toBe(82000);
});

test("a flat position reports no entry and no liquidation price", () => {
  const a = accountFromOkx(
    { totalEq: "100", details: [{ ccy: "USDT", availBal: "100" }] },
    [{ instId: "BTC-USDT-SWAP", pos: "0", posSide: "net", avgPx: "0", liqPx: "" }],
    btc,
    "USDT",
  );
  expect(a.positionSz).toBe(0);
  expect(a.entryPrice).toBe(null);
  expect(a.liquidationPx).toBe(null);
  expect(a.withdrawable).toBe(100);
});

test("a charged fee flips sign once, on the way in", () => {
  const f = okxFill(
    { instId: "BTC-USDT-SWAP", ordId: "77", tradeId: "9", fillPx: "85000", fillSz: "0.47", fillPnl: "0", fee: "-0.02", side: "buy", subType: "3", fillTime: "1700000000000" },
    btc,
    "BTC",
  )!;
  // OKX writes a charged fee negative. This desk counts a charge as positive.
  expect(f.print.feeUsd).toBeCloseTo(0.02, 10);
  expect(f.pnl.fee).toBeCloseTo(0.02, 10);
  expect(f.print.size).toBeCloseTo(0.0047, 10);
  expect(f.print.dir).toBe("open");
  expect(f.pnl.coin).toBe("BTC");
  expect(f.pnl.tid).toBe("9");
});

test("direction comes from the bill subtype, and falls back to realized PnL", () => {
  expect(fillDirFromSubType("3")).toBe("open");
  expect(fillDirFromSubType("6")).toBe("close");
  expect(fillDirFromSubType("101")).toBe("close");
  expect(fillDirFromSubType("")).toBe(undefined);
  const streamed = okxFill(
    { ordId: "1", tradeId: "2", fillPx: "85000", fillSz: "0.47", fillPnl: "1.5", fee: "-0.01", side: "sell", fillTime: "1" },
    btc,
    "BTC",
  )!;
  // The live order stream carries no subtype. OKX books PnL only on a reduce.
  expect(streamed.print.dir).toBe("close");
  expect(streamed.print.closedPnl).toBe(1.5);
});

test("a fill with no trade id is an order update, not a fill", () => {
  expect(okxFill({ ordId: "1", fillPx: "85000", fillSz: "0", side: "buy" }, btc, "BTC")).toBe(null);
  expect(okxFill({ ordId: "1", tradeId: "2", fillPx: "0", fillSz: "1", side: "buy" }, btc, "BTC")).toBe(null);
});

test("venue context lands in the same fields Hyperliquid fills", () => {
  const ctx = assetCtxFromOkx({
    ticker: { last: "85000", open24h: "84000", volCcy24h: "1000" },
    mark: { markPx: "85010" },
    funding: { fundingRate: "0.0001", premium: "-0.0003" },
    openInterest: { oiCcy: "30407.98" },
    index: { idxPx: "85005" },
  });
  expect(ctx.markPx).toBe(85010);
  expect(ctx.oraclePx).toBe(85005);
  expect(ctx.funding).toBe(0.0001);
  expect(ctx.premium).toBe(-0.0003);
  expect(ctx.openInterest).toBe(30407.98);
  expect(ctx.prevDayPx).toBe(84000);
  // volCcy24h counts coins, so the notional is that against the last trade.
  expect(ctx.dayNtlVlm).toBe(85_000_000);
  expect(assetCtxFromOkx({}).markPx).toBe(null);
});

test("OKX names the hour and up in capitals", () => {
  expect(okxBar("1m")).toBe("1m");
  expect(okxBar("15m")).toBe("15m");
  expect(okxBar("1h")).toBe("1H");
  expect(okxBar("4h")).toBe("4H");
  expect(okxBar("1d")).toBe("1D");
});

test("a candle row keeps its high and low around open and close", () => {
  const rows = rowsToOhlc([["1700000000000", "100", "103", "99", "102", "1", "1", "1", "1"], ["bad", "1", "1", "1", "1"]]);
  expect(rows).toEqual([{ ts: 1700000000000, open: 100, high: 103, low: 99, close: 102 }]);
});

test("signing is deterministic and the login frame signs seconds", () => {
  const prehash = "2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC";
  expect(signature("secret", prehash)).toBe(signature("secret", prehash));
  expect(signature("secret", prehash)).not.toBe(signature("other", prehash));
  const login = wsLogin({ apiKey: "k", secret: "s", passphrase: "p" }, 1538054050000);
  expect(login.op).toBe("login");
  expect(login.args[0]!.timestamp).toBe("1538054050");
  expect(login.args[0]!.sign).toBe(signature("s", "1538054050GET/users/self/verify"));
});
