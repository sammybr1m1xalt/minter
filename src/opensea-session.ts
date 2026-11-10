// opensea-session.ts — automated OpenSea SIWE (Sign-In With Ethereum) login.
//
// OpenSea gates drop eligibility + signed-mint transaction building behind
// a logged-in session (an access_token JWT cookie). Because we hold the wallet
// private key we can perform the SIWE handshake headlessly and refresh it
// automatically when the token nears expiry — no manual cookie pasting.
//
// Flow (reverse-engineered from the opensea.io web app):
//   1. POST /__api/auth/siwe/nonce                 → { nonce } (+ __cf_bm cookie)
//   2. build the EIP-4361 message, wallet.signMessage(it)
//   3. POST /__api/auth/siwe/verify { message, signature, chainArch, connectorId }
//                                                   → sets access_token cookie
// The access_token is a JWT; we cache it per address and re-login when exp-60s
// has passed.

import { Wallet } from "ethers";

export interface StoredSession {
  cookies: Map<string, string>;
  token: string;
  exp: number;
}

export interface StoredSiweSession extends StoredSession {}

const BASE = "https://opensea.io/__api/auth";
const DOMAIN = "opensea.io";
const URI = "https://opensea.io/";
const STATEMENT =
  "Click to sign in and accept the Platform Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).";
// connectorId observed in the web app. The server validates the signature, not
// the wallet brand, so a known-good value is fine for a headless signer.
const CONNECTOR_ID = "io.rabby";
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  origin: "https://opensea.io",
  referer: "https://opensea.io/",
};

// Per-address session cache: address(lower) → { cookies:Map, token, exp }.
const sessions = new Map<string, StoredSession>();

// ── Cookie helpers ───────────────────────────────────────────────────────────
function absorbCookies(jar: Map<string, string>, setCookieHeaders: string[] | null): void {
  if (!setCookieHeaders) return;
  for (const line of setCookieHeaders) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ── SIWE message construction ────────────────────────────────────────────────
function buildSiweMessage({
  address,
  nonce,
  issuedAt,
  chainId = 1,
}: {
  address: string;
  nonce: string;
  issuedAt: string;
  chainId?: number;
}): string {
  // Field order and spacing must match what the server reconstructs,
  // or ecrecover yields the wrong address and verify rejects it.
  return (
    `${DOMAIN} wants you to sign in with your Ethereum account:\n` +
    `${address}\n\n` +
    `${STATEMENT}\n\n` +
    `URI: ${URI}\n` +
    `Version: 1\n` +
    `Chain ID: ${chainId}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  );
}

// Decode a JWT payload without verification (we only need the exp claim).
function jwtExp(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    return Number(payload.exp) || 0;
  } catch {
    return 0;
  }
}

// ── SIWE flow ─────────────────────────────────────────────────────────────────
async function fetchNonce(jar: Map<string, string>): Promise<string> {
  const r = await fetch(`${BASE}/siwe/nonce`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader(jar),
      ...BROWSER_HEADERS,
    },
    signal: AbortSignal.timeout(10_000),
  });
  absorbCookies(jar, extractSetCookie(r));
  if (!r.ok) throw new Error(`siwe nonce ${r.status}`);
  const j = (await r.json()) as { nonce?: string };
  if (!j?.nonce) throw new Error("siwe nonce: missing nonce");
  return j.nonce;
}

// Perform a full SIWE login for wallet. Returns StoredSession.
async function loginSiwe(wallet: Wallet): Promise<StoredSession> {
  const jar = new Map<string, string>();
  const address = wallet.address;
  // Tell OpenSea which wallet this session is for, BEFORE the nonce request.
  // The eligibility resolver keys off this cookie; without it isEligible is
  // null even for a valid authenticated session (learned from osnm-z).
  jar.set("connected-account-server-hint", address.toLowerCase());
  const nonce = await fetchNonce(jar);
  const issuedAt = new Date().toISOString();
  const messageStr = buildSiweMessage({ address, nonce, issuedAt });
  const signature = await wallet.signMessage(messageStr);
  // verify wants the message as a structured object (server re-serializes it).
  const messageObj = {
    domain: DOMAIN,
    address,
    statement: STATEMENT,
    uri: URI,
    version: "1",
    chainId: "1",
    nonce,
    issuedAt,
    accountType: "Ethereum",
  };
  const r = await fetch(`${BASE}/siwe/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader(jar),
      ...BROWSER_HEADERS,
    },
    body: JSON.stringify({
      message: messageObj,
      signature,
      chainArch: "EVM",
      connectorId: CONNECTOR_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`siwe verify ${r.status}: ${txt.slice(0, 200)}`);
  }
  absorbCookies(jar, extractSetCookie(r));
  const token = jar.get("access_token");
  if (!token) throw new Error("siwe verify: no access_token cookie returned");
  const session: StoredSession = {
    cookies: jar,
    token,
    exp: jwtExp(token),
  };
  sessions.set(address.toLowerCase(), session);
  return session;
}

// Refresh an existing session without re-signing, using the refresh_token
// cookie (POST /__api/auth/session/refresh). Returns an updated session or
// null when refresh isn't possible.
async function tryRefreshSiwe(cached: StoredSession): Promise<StoredSession | null> {
  const refreshToken = cached.cookies.get("refresh_token");
  if (!refreshToken) return null;
  const jar = new Map(cached.cookies); // clone; refresh may rotate cookies
  const r = await fetch(`${BASE}/session/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader(jar),
      ...BROWSER_HEADERS,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return null;
  absorbCookies(jar, extractSetCookie(r));
  const token = jar.get("access_token");
  if (!token) return null;
  const session: StoredSession = {
    cookies: jar,
    token,
    exp: jwtExp(token),
  };
  return session;
}

// Get a valid session cookie header for wallet. Uses the cache when fresh,
// refreshes with the refresh_token when near expiry (cheap, no signature), and
// only falls back to a full SIWE login when refresh is unavailable/fails.
export async function getSessionCookies(wallet: Wallet): Promise<string> {
  const key = wallet.address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const cached = sessions.get(key);
  // Cache hit: token is still valid + 60s buffer
  if (cached && cached.exp > now + 60) {
    return cookieHeader(cached.cookies);
  }
  // Near/after expiry: try a lightweight refresh before a full re-login.
  if (cached) {
    const refreshed = await tryRefreshSiwe(cached).catch(() => null);
    if (refreshed && refreshed.exp > now + 60) {
      sessions.set(key, refreshed);
      return cookieHeader(refreshed.cookies);
    }
  }
  // Full SIWE login
  const session = await loginSiwe(wallet);
  sessions.set(key, session);
  return cookieHeader(session.cookies);
}

// Force a fresh SIWE login (e.g. after a 401), bypassing cache and refresh.
export async function refreshSiweSession(wallet: Wallet): Promise<string> {
  sessions.delete(wallet.address.toLowerCase());
  const session = await loginSiwe(wallet);
  sessions.set(wallet.address.toLowerCase(), session);
  return cookieHeader(session.cookies);
}

// ── Internal: extract Set-Cookie headers in a fetch-compatible way ───────────
// node-fetch and undici both support `response.headers.getSetCookie?.()` (Node 18+).
// For older runtimes that don't, fall back to the `set-cookie` header.
function extractSetCookie(res: Response): string[] | null {
  const headers = res.headers;
  if (typeof (headers as any).getSetCookie === "function") {
    return (headers as any).getSetCookie();
  }
  const raw = headers.get("set-cookie");
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw;
  return null;
}
