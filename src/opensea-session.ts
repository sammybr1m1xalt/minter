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

import fs from "fs";
import { Wallet } from "ethers";
import { sessionDir, siweSessionsFile } from "./session-store";

/**
 * A live SIWE login. Deliberately NOT the same type as the stored session in
 * fcfs-mint.ts (accessToken/refreshToken/expiresAt): that one is the persisted
 * legacy shape, this one is a per-wallet cookie jar. Two interfaces with the same
 * name and incompatible fields made it possible to pass one where the other was
 * expected.
 *
 * Persisted to .minter-session/opensea_sessions.json (owner-only), keyed by
 * address, so a restart can refresh instead of re-signing.
 */
export interface SiweSession {
  cookies: Map<string, string>;
  token: string;
  exp: number;
  // ── Wallet JWT (scoped PAT → access token) ──────────────────────────────
  // The REST drop-eligibility endpoint needs a WALLET token; the SIWE cookie is
  // not one. See getWalletJwt below for the flow and the live verification.
  jwt?: string;
  jwtExp?: number;
  scopes?: string[];
  pat?: string;
  patId?: string;
  patExp?: number;
}

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
const sessions = new Map<string, SiweSession>();

// ── Persistence ──────────────────────────────────────────────────────────────
// A SIWE login costs a wallet signature and two round trips. Within one run the
// map above is enough, but a run that restarts — a crash, or a re-run before the
// drop opens — used to throw the login away and pay for it again. Worse, a
// restart with a still-valid refresh_token had to re-SIGN, when a refresh is
// enough. So the jar is written on every change and read once, lazily, on the
// first session request of the process.

interface PersistedSiweSessions {
  version: 1;
  sessions: Record<string, {
    cookies: Record<string, string>;
    token: string;
    exp: number;
    jwt?: string;
    jwtExp?: number;
    scopes?: string[];
    pat?: string;
    patId?: string;
    patExp?: number;
  }>;
}

let loadedFromDisk = false;

function loadPersistedSessions(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(siweSessionsFile(), "utf-8")) as PersistedSiweSessions;
    const entries = parsed?.sessions;
    if (!entries || typeof entries !== "object") return;
    for (const [addr, s] of Object.entries(entries)) {
      if (!s || typeof s.token !== "string" || !s.cookies) continue;
      sessions.set(addr, {
        cookies: new Map(Object.entries(s.cookies)),
        token: s.token,
        exp: Number(s.exp) || 0,
        // Absent on sessions written before the wallet-JWT leg existed; the
        // optional fields degrade to "no cached token" rather than a parse error.
        jwt: typeof s.jwt === "string" ? s.jwt : undefined,
        jwtExp: Number(s.jwtExp) || 0,
        scopes: Array.isArray(s.scopes) ? s.scopes : undefined,
        pat: typeof s.pat === "string" ? s.pat : undefined,
        patId: typeof s.patId === "string" ? s.patId : undefined,
        patExp: Number(s.patExp) || 0,
      });
    }
  } catch {
    // No cache yet, or unreadable — a fresh login is the fallback.
  }
}

// ── Read-only inspection (doctor) ────────────────────────────────────────────

export interface StoredSessionStatus {
  address: string;
  /** Unix seconds. 0 when the token carried no expiry. */
  exp: number;
  expKnown: boolean;
  expired: boolean;
  tokenPresent: boolean;
  cookieCount: number;
}

/**
 * Report the persisted sessions without touching the network or creating one.
 *
 * Deliberately side-effect free apart from the one-time disk read: a doctor run
 * must never trigger a login, because a login costs a wallet signature and a
 * doctor run may have no wallet at all. An unreadable jar yields an empty list,
 * which the caller reports as "no sessions" rather than as an error.
 */
export function inspectStoredSessions(): StoredSessionStatus[] {
  loadPersistedSessions();
  const now = Math.floor(Date.now() / 1000);
  return [...sessions.entries()]
    .map(([address, s]) => ({
      address,
      exp: s.exp,
      expKnown: s.exp > 0,
      expired: s.exp > 0 && s.exp <= now,
      tokenPresent: !!s.token,
      cookieCount: s.cookies.size,
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

function persistSessions(): void {
  try {
    const payload: PersistedSiweSessions = { version: 1, sessions: {} };
    for (const [addr, s] of sessions) {
      payload.sessions[addr] = {
        // A Map serialises to {} under JSON.stringify, so it is converted
        // explicitly — a silently empty cookie jar would be worse than none.
        cookies: Object.fromEntries(s.cookies),
        token: s.token,
        exp: s.exp,
        jwt: s.jwt,
        jwtExp: s.jwtExp,
        scopes: s.scopes,
        pat: s.pat,
        patId: s.patId,
        patExp: s.patExp,
      };
    }
    // Contains bearer tokens: owner-only, like the legacy session file.
    require("fs").mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(siweSessionsFile(), JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // A cache that cannot be written must never break a login.
  }
}

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

// A transport failure (UND_ERR_CONNECT_TIMEOUT, ECONNRESET, socket hangup) says
// nothing about the wallet or the credentials — the request never completed.
// Observed live: the same SIWE nonce endpoint returned UND_ERR_CONNECT_TIMEOUT
// on 6 consecutive attempts and then 200 on the next, with no change on our
// side. Throwing on the first one made session creation a coin flip.
//
// Two attempts, and the underlying cause is preserved in the message so a real
// outage is still diagnosable instead of reading as a bad wallet.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 2
): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err: any) {
      lastErr = err;
      if (i < attempts - 1) {
        // Brief backoff — the failures cluster, so a short pause lets the
        // network recover rather than immediately re-hitting the same route.
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  const code = lastErr?.cause?.code || lastErr?.name || "unknown";
  throw new Error(`transport ${code}: ${lastErr?.message || "fetch failed"}`);
}

async function fetchNonce(jar: Map<string, string>): Promise<string> {
  const r = await fetchWithRetry(
    `${BASE}/siwe/nonce`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(jar),
        ...BROWSER_HEADERS,
      },
      signal: AbortSignal.timeout(10_000),
    }
  );
  absorbCookies(jar, extractSetCookie(r));
  if (!r.ok) throw new Error(`siwe nonce ${r.status}`);
  const j = (await r.json()) as { nonce?: string };
  if (!j?.nonce) throw new Error("siwe nonce: missing nonce");
  return j.nonce;
}

// Perform a full SIWE login for wallet. Returns SiweSession.
async function loginSiwe(wallet: Wallet): Promise<SiweSession> {
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
  const r = await fetchWithRetry(`${BASE}/siwe/verify`, {
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
  const session: SiweSession = {
    cookies: jar,
    token,
    exp: jwtExp(token),
  };
  sessions.set(address.toLowerCase(), session);
  persistSessions();
  return session;
}

// Refresh an existing session without re-signing, using the refresh_token
// cookie (POST /__api/auth/session/refresh). Returns an updated session or
// null when refresh isn't possible.
async function tryRefreshSiwe(cached: SiweSession): Promise<SiweSession | null> {
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
  const session: SiweSession = {
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
  loadPersistedSessions();
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
      persistSessions();
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

// ── Wallet JWT: scoped PAT → access token ───────────────────────────────────
//
// The REST drop-eligibility endpoint needs a WALLET token. The SIWE cookie is
// not one, and the API key alone answers 401 ("Wallet token lacks permission").
// The documented route from the session we already hold:
//
//   SIWE session cookies
//     → POST /api/v2/auth/tokens           {label, scopes, expiresInDays} → PAT
//     → POST /api/v2/auth/tokens/exchange  {subjectToken, subjectTokenType} → JWT
//
// Verified live 2026-11-13 against a real session:
//   - the PAT is returned ONCE, at creation; GET /auth/tokens lists metadata
//     only and never the token, so it must be stored or it is lost;
//   - the exchange answers expiresIn=3599 — ONE HOUR, not the ~12h the docs'
//     credential table claims. The cache margin below is sized for the measured
//     value, not the documented one;
//   - the JWT unlocks GET /api/v2/drops/{slug}/eligibility (401 without it,
//     200 with it) and carries tokenScopes ["read:eligibility"].
//
// An earlier probe of this flow reported 403 "Token exchange is not available";
// that was wrong — the exchange works. The REST fallback is therefore real.

const AUTH_BASE = "https://api.opensea.io/api/v2/auth";
const PAT_SCOPES = ["read:eligibility"];
const PAT_LIFETIME_DAYS = 7;
/** Re-issue a JWT this long before it expires. */
const JWT_MARGIN_SEC = 600;
/** Create a fresh PAT this long before the cached one expires. */
const PAT_MARGIN_SEC = 24 * 3600;

export interface WalletToken {
  jwt: string;
  /** Unix seconds. */
  exp: number;
  scopes: string[];
}

/**
 * Create a scoped PAT from a SIWE session.
 *
 * One retry: the endpoint answered a bare 400 once and 200 for the identical
 * request seconds later. A real validation failure (400 with `details`, or 422
 * for a missing field) is deterministic and will not pass on retry — the retry
 * costs one call and only fires when we have no token to show for it.
 */
async function createScopedToken(cookie: string): Promise<{ id: string; token: string; exp: number } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: Response;
    try {
      r = await fetchWithRetry(
        `${AUTH_BASE}/tokens`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", cookie },
          body: JSON.stringify({ label: "minter", scopes: PAT_SCOPES, expiresInDays: PAT_LIFETIME_DAYS }),
          signal: AbortSignal.timeout(10_000),
        },
        1
      );
    } catch {
      return null; // transport failure — nothing about the session
    }
    if (r.ok) {
      try {
        const j = (await r.json()) as any;
        if (!j?.token) return null;
        return {
          id: String(j.id ?? ""),
          token: j.token,
          exp: Math.floor(new Date(j.expiresAt).getTime() / 1000) || 0,
        };
      } catch {
        return null;
      }
    }
    // 422 (missing field) and a validation 400 will not fix themselves; a 5xx or
    // a bare 400 might. Either way one retry is the budget.
  }
  return null;
}

/** Exchange a PAT for a short-lived wallet JWT. */
async function exchangeForWalletJwt(pat: string): Promise<WalletToken | null> {
  try {
    const r = await fetchWithRetry(
      `${AUTH_BASE}/tokens/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ subjectToken: pat, subjectTokenType: "ACCESS_TOKEN" }),
        signal: AbortSignal.timeout(10_000),
      },
      1
    );
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    if (!j?.accessToken) return null;
    return {
      jwt: j.accessToken,
      exp: Math.floor(Date.now() / 1000) + Number(j.expiresIn) || 0,
      scopes: Array.isArray(j.tokenScopes) ? j.tokenScopes : [],
    };
  } catch {
    return null;
  }
}

function cacheWalletToken(
  address: string,
  token: WalletToken,
  pat?: { id: string; token: string; exp: number }
): void {
  const cached = sessions.get(address);
  if (!cached) return;
  cached.jwt = token.jwt;
  cached.jwtExp = token.exp;
  cached.scopes = token.scopes;
  if (pat) {
    cached.pat = pat.token;
    cached.patId = pat.id;
    cached.patExp = pat.exp;
  }
  persistSessions();
}

/**
 * A wallet-scoped JWT for `address`, or null when no session can produce one.
 *
 * Takes an ADDRESS, not a Wallet: the session jar is already on disk keyed by
 * address, so no private key is needed — only a cached SIWE login for that
 * wallet. That matters because the eligibility path knows the wallet address
 * but not necessarily its key.
 *
 * Order: cached JWT → exchange the cached PAT → create a PAT, then exchange.
 */
export async function getWalletJwt(address: string): Promise<WalletToken | null> {
  loadPersistedSessions();
  const key = address.toLowerCase();
  const cached = sessions.get(key);
  if (!cached) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cached.jwt && (cached.jwtExp ?? 0) > now + JWT_MARGIN_SEC) {
    return { jwt: cached.jwt, exp: cached.jwtExp as number, scopes: cached.scopes ?? PAT_SCOPES };
  }

  // A still-valid PAT can be exchanged without creating a new one — the PAT is
  // the scarce object (creation is session-scoped and rate-limited), the JWT is
  // not.
  if (cached.pat && (cached.patExp ?? 0) > now + PAT_MARGIN_SEC) {
    const exchanged = await exchangeForWalletJwt(cached.pat);
    if (exchanged) {
      cacheWalletToken(key, exchanged);
      return exchanged;
    }
  }

  const pat = await createScopedToken(cookieHeader(cached.cookies));
  if (!pat) return null;
  const exchanged = await exchangeForWalletJwt(pat.token);
  if (!exchanged) return null;
  cacheWalletToken(key, exchanged, pat);
  return exchanged;
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
