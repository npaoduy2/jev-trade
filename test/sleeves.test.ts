import { expect, test } from "bun:test";
import { coinPair, loadSleeves, parseWalletsJson, sameCoin } from "../src/sleeves";

test("coinPair is the perp name the venue uses", () => {
  expect(coinPair("BTC", "hyperliquid")).toBe("BTC-USD");
  expect(coinPair("ETH", "hyperliquid")).toBe("ETH-USD");
  expect(coinPair("BTC", "okx", "USDT")).toBe("BTC-USDT-SWAP");
  expect(coinPair("DOGE", "okx", "USDC")).toBe("DOGE-USDC-SWAP");
});

test("sameCoin is exact", () => {
  expect(sameCoin("BTC", "BTC")).toBe(true);
  expect(sameCoin("BTC", "ETH")).toBe(false);
  expect(sameCoin(undefined, "BTC")).toBe(false);
});

test("loadSleeves follows HL_COINS", () => {
  const prev = process.env.HL_COINS;
  process.env.HL_COINS = "BTC,ETH";
  try {
    const sleeves = loadSleeves("hyperliquid");
    expect(sleeves.map((s) => s.coin)).toEqual(["BTC", "ETH"]);
    expect(sleeves[0]!.label).toBe("BTC");
    expect(sleeves[1]!.pair).toBe("ETH-USD");
  } finally {
    if (prev == null) delete process.env.HL_COINS;
    else process.env.HL_COINS = prev;
  }
});

test("COINS wins over HL_COINS", () => {
  const prevNew = process.env.COINS;
  const prevOld = process.env.HL_COINS;
  process.env.COINS = "SOL,AAVE";
  process.env.HL_COINS = "BTC,ETH";
  try {
    expect(loadSleeves("hyperliquid").map((s) => s.coin)).toEqual(["SOL", "AAVE"]);
  } finally {
    if (prevNew == null) delete process.env.COINS;
    else process.env.COINS = prevNew;
    if (prevOld == null) delete process.env.HL_COINS;
    else process.env.HL_COINS = prevOld;
  }
});

test("parseWalletsJson reads sleeves array or coin map", () => {
  const keyA = `0x${"aa".repeat(32)}`;
  const keyB = `0x${"bb".repeat(32)}`;
  expect(parseWalletsJson(JSON.stringify({ sleeves: [{ coin: "ETH", privateKey: keyA }] })).get("ETH")).toBe(keyA);
  expect(parseWalletsJson(JSON.stringify({ SOL: keyB })).get("SOL")).toBe(keyB);
  expect(parseWalletsJson("not-json").size).toBe(0);
});

test("loadSleeves reads WALLETS_JSON for non-first coins", () => {
  const prevCoins = process.env.HL_COINS;
  const prevJson = process.env.WALLETS_JSON;
  const prevKey = process.env.PRIVATE_KEY;
  const btc = `0x${"11".repeat(32)}`;
  const eth = `0x${"22".repeat(32)}`;
  process.env.HL_COINS = "TESTBTC,TESTETH";
  process.env.PRIVATE_KEY = btc;
  process.env.WALLETS_JSON = JSON.stringify({ sleeves: [{ coin: "TESTETH", privateKey: eth }] });
  try {
    const sleeves = loadSleeves("hyperliquid");
    expect(sleeves[0]!.privateKey).toBe(btc);
    expect(sleeves[1]!.privateKey).toBe(eth);
  } finally {
    if (prevCoins == null) delete process.env.HL_COINS;
    else process.env.HL_COINS = prevCoins;
    if (prevJson == null) delete process.env.WALLETS_JSON;
    else process.env.WALLETS_JSON = prevJson;
    if (prevKey == null) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  }
});
