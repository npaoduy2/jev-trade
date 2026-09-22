import { config, type OkxCredentials } from "../config";

const HOST = "https://www.okx.com";

/**
 * Demo trading shares the REST host and switches on a header, but it is a
 * separate exchange: its own book, its own balances, and its own contract
 * specs. Demo BTC-USDT-SWAP quotes a 0.01 tick where live quotes 0.1, so the
 * header rides on public reads too or the quote price would not align.
 */
export const demoHeader = (): Record<string, string> => (config.okxDemo ? { "x-simulated-trading": "1" } : {});

export const WS_PUBLIC = () =>
  config.okxDemo ? "wss://wspap.okx.com:8443/ws/v5/public" : "wss://ws.okx.com:8443/ws/v5/public";
export const WS_BUSINESS = () =>
  config.okxDemo ? "wss://wspap.okx.com:8443/ws/v5/business" : "wss://ws.okx.com:8443/ws/v5/business";
export const WS_PRIVATE = () =>
  config.okxDemo ? "wss://wspap.okx.com:8443/ws/v5/private" : "wss://ws.okx.com:8443/ws/v5/private";

export interface Envelope<T> {
  code: string;
  msg: string;
  data?: T[];
}

export class OkxError extends Error {
  constructor(readonly code: string, message: string, readonly path: string) {
    super(message);
    this.name = "OkxError";
  }
}

/** Throttling, on the venue's codes or on plain HTTP 429. */
export function isRateLimited(e: unknown): boolean {
  if (e instanceof OkxError) return e.code === "50011" || e.code === "50061" || e.code === "429";
  return /rate.?limit|too many requests/i.test(e instanceof Error ? e.message : String(e));
}

/** Base64 HMAC-SHA256 over `timestamp + METHOD + path + body`, as OKX signs it. */
export function signature(secret: string, prehash: string): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(prehash);
  return h.digest("base64");
}

export function signedHeaders(
  cred: OkxCredentials,
  method: "GET" | "POST",
  path: string,
  body: string,
  now = new Date(),
): Record<string, string> {
  const timestamp = now.toISOString();
  return {
    "OK-ACCESS-KEY": cred.apiKey,
    "OK-ACCESS-SIGN": signature(cred.secret, `${timestamp}${method}${path}${body}`),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": cred.passphrase,
  };
}

/** The WS `login` frame. Signs the same way, over seconds and a fixed path. */
export function wsLogin(cred: OkxCredentials, now = Date.now()) {
  const timestamp = Math.floor(now / 1000).toString();
  return {
    op: "login",
    args: [
      {
        apiKey: cred.apiKey,
        passphrase: cred.passphrase,
        timestamp,
        sign: signature(cred.secret, `${timestamp}GET/users/self/verify`),
      },
    ],
  };
}

async function unwrap<T>(res: Response, path: string): Promise<T[]> {
  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new OkxError(String(res.status), `okx ${path} HTTP ${res.status}`, path);
  }
  if (body.code !== "0") throw new OkxError(body.code, `${body.msg || "okx error"} (${body.code})`, path);
  return body.data ?? [];
}

/** Public read. Runs without a key, so a dry run sees the book a live key sees. */
export async function publicGet<T>(path: string): Promise<T[]> {
  const res = await fetch(`${HOST}${path}`, { headers: demoHeader() });
  return unwrap<T>(res, path);
}

/** Signed REST for one account. */
export class OkxClient {
  constructor(private cred: OkxCredentials) {}

  async get<T>(path: string): Promise<T[]> {
    const res = await fetch(`${HOST}${path}`, {
      headers: { ...demoHeader(), ...signedHeaders(this.cred, "GET", path, "") },
    });
    return unwrap<T>(res, path);
  }

  async post<T>(path: string, payload: unknown): Promise<T[]> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${HOST}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...demoHeader(),
        ...signedHeaders(this.cred, "POST", path, body),
      },
      body,
    });
    return unwrap<T>(res, path);
  }
}
