// ── OpenSea free API key POOL management ─────────────────────────────────
//
// Manages MULTIPLE free-tier keys (minted via POST /api/v2/auth/keys).
// Before the FCFS mint fires, probes all keys in parallel and picks the
// best one — alive, responsive, least-used — so a rate-limited or dead
// key never blocks the mint at T-0.
//
// Keys are cached to disk. New keys are minted on demand (subject to
// OpenSea's rate limit: max 2 keys/day for free tier).
//
// ⚠ DOCUMENTED LIMITATION (verified against docs.opensea.io/reference/api-keys,
//   2026-11-06): "All API keys under the same account share a single rate limit
//   bucket. Creating multiple API keys will not increase your overall rate
//   limit." and "Minting extra keys is not a way to get more throughput."
//
// So the pool does NOT buy extra quota. What it does buy:
//   - failover when one key is throttled or dead (the bucket is shared, but a
//     dead/expired key is still unusable while a live one works)
//   - continuity across the 7-day key expiry
// It does NOT raise the ceiling. For more throughput the only documented path
// is upgrading to a full key at opensea.io/settings/developer.
//
// Free-tier documented rates: 600/h read, 30/h write, 5/m fulfillment.
// Live probe returned X-RateLimit-Limit: 120 — the docs also warn that "some
// endpoint groups are metered more tightly than the headline read rate", so
// always read the headers rather than assuming a number.

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

const KEY_CACHE_DIR = process.env.OPENSEA_SESSION_DIR
  ? process.env.OPENSEA_SESSION_DIR
  : (() => {
      const d = process.env.HOME ? path.join(process.env.HOME, ".nft-public-mint") : "";
      try { fs.mkdirSync(d, { recursive: true }); } catch {}
      return d;
    })();

const KEY_POOL_FILE = path.join(KEY_CACHE_DIR, "opensea_key_pool.json");
// Records that today's free-key creation attempt already failed, so we don't
// burn a request re-POSTing on every run. Keyed by local-midnight timestamp.
const QUOTA_FILE = path.join(KEY_CACHE_DIR, "opensea_quota.json");
const OPENSEA_BASE = "https://api.opensea.io";
const FREE_KEY_ENDPOINT = `${OPENSEA_BASE}/api/v2/auth/keys`;

// ── Key pool entry ────────────────────────────────────────────────────────

export interface KeyPoolEntry {
  api_key: string;
  name: string;
  expires_at: string;
  minted_at: string;
  times_used: number;
  last_probe: "alive" | "throttled" | "dead" | "timeout" | "unknown" | "alive_but_exhausted" | "server_error";
  last_probe_at: string;
  probe_latency_ms: number;
  score: number;
  remaining_calls: number; // X-RateLimit-Remaining from last probe/response
  rate_limit_reset: number; // X-RateLimit-Reset (unix epoch) — when window resets
}

// ── Key lifecycle helpers ──────────────────────────────────────────────────

/** How old a key is, in days, from its minted_at timestamp. */
function daysOld(entry: KeyPoolEntry): number {
  if (!entry.minted_at) return Infinity;
  const born = new Date(entry.minted_at).getTime();
  if (isNaN(born)) return Infinity;
  return (Date.now() - born) / 86_400_000;
}

/** UNIX ms for the start of today (midnight local). */
function todayMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * ⚠ The daily key-creation quota does NOT reset at midnight.
 *
 * OPENSEA_API_LAYOUT.txt claims "Quota state (QUOTA_FILE) resets at UTC
 * midnight (not 24h from 429)". That is wrong. Verified live 2026-11-06:
 * X-RateLimit-Reset was 1794036334 = 07:25:34 UTC, i.e. a ROLLING window that
 * had already expired a minute before the probe. The window slides; it is not
 * anchored to any midnight.
 *
 * Consequence: the local-midnight marker below is an approximation. It is still
 * useful (it stops us re-POSTing every run within a day) but it can block a
 * legitimate mint if the rolling window has already recovered while the local
 * day has not. Callers that need certainty should re-probe rather than trust
 * this marker.
 */

/** How many keys in the pool were created today (local midnight). */
function keysCreatedToday(pool: KeyPoolEntry[]): number {
  const todayStart = todayMidnightMs();
  return pool.filter((e) => {
    const born = e.minted_at ? new Date(e.minted_at).getTime() : 0;
    return born >= todayStart;
  }).length;
}

// ── Daily quota marker ──────────────────────────────────────────────────────
// OpenSea allows 2 free key creations per day per IP. Once an attempt fails
// with 429, retrying on every run wastes a request and produces the same 429.
// Persist the failure so the code can skip the POST until the next local day.

interface QuotaState {
  rate_limited_today: boolean;
  last_429_at: number;
  /** Retry-After from the last 429, in seconds. Authoritative when present. */
  retry_after_seconds: number;
  cached_keys_created_today: number;
}

function readQuota(): QuotaState {
  try {
    return JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8")) as QuotaState;
  } catch {
    return {
      rate_limited_today: false,
      last_429_at: 0,
      retry_after_seconds: 0,
      cached_keys_created_today: 0,
    };
  }
}

function writeQuota(state: QuotaState): void {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {}
}

/**
 * True when the creation quota is still exhausted.
 *
 * Prefers Retry-After from the last 429 — that is the server's own statement of
 * when the window opens. Falls back to local midnight only when no Retry-After
 * was recorded. Verified live: a 429 returned Retry-After: 41550 (~11.5 hours),
 * which is neither 1 hour nor 24 hours, so no fixed period is correct.
 */
function quotaExhaustedToday(): boolean {
  const q = readQuota();
  if (!q.rate_limited_today) return false;
  if (q.retry_after_seconds > 0 && q.last_429_at > 0) {
    return Date.now() < q.last_429_at + q.retry_after_seconds * 1000;
  }
  // No Retry-After recorded — approximate with the local day boundary.
  return q.last_429_at >= todayMidnightMs();
}

function markQuotaExhausted(retryAfterSeconds = 0): void {
  writeQuota({
    rate_limited_today: true,
    last_429_at: Date.now(),
    retry_after_seconds: retryAfterSeconds,
    cached_keys_created_today: keysCreatedToday(loadKeyPool()),
  });
}

/** Strip stale keys: expired (expires_at past) or older than 7 days. */
export function pruneStaleKeys(pool: KeyPoolEntry[]): KeyPoolEntry[] {
  const now = Date.now();
  return pool.filter((e) => {
    // Expired key — but see the warning below before trusting this.
    if (e.expires_at) {
      const exp = new Date(e.expires_at).getTime();
      if (!isNaN(exp) && exp < now) {
        // OpenSea's expires_at is NOT enforced. Verified 2026-11-06: a key with
        // expires_at 2026-10-17 (21 days past) still returns HTTP 200 on
        // /api/v2/collections. Pruning on this field alone would discard keys
        // that work. Only drop the key if it has also been probed dead — the
        // probe is the authoritative signal, the timestamp is not.
        if (e.last_probe === "dead") return false;
      }
    }
    // Older than 7 days. Same caveat: age alone is not proof of death. Keep
    // the key if it was recently probed alive; the next probe will retire it
    // if it has actually stopped working.
    if (daysOld(e) > 7 && e.last_probe === "dead") return false;
    return true;
  });
}

export function loadKeyPool(): KeyPoolEntry[] {
  try {
    const raw = fs.readFileSync(KEY_POOL_FILE, "utf-8");
    const pool = JSON.parse(raw) as KeyPoolEntry[];
    // Auto-prune stale keys on every load — expired or older than 7 days
    return pruneStaleKeys(pool);
  } catch {
    return [];
  }
}

export function saveKeyPool(pool: KeyPoolEntry[]): void {
  fs.writeFileSync(KEY_POOL_FILE, JSON.stringify(pool, null, 2), "utf-8");
}

export function clearKeyPool(): void {
  try { fs.unlinkSync(KEY_POOL_FILE); } catch {}
}

// ── Probe a single key ────────────────────────────────────────────────────

export async function probeKey(
  apiKey: string,
  timeoutMs = 3000
): Promise<{ status: "alive" | "throttled" | "dead" | "alive_but_exhausted" | "timeout" | "server_error"; latencyMs: number; remaining: number; resetAt: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${OPENSEA_BASE}/api/v2/collections?limit=1`, {
      signal: controller.signal,
      headers: { accept: "application/json", "X-API-KEY": apiKey.trim() },
    });
    clearTimeout(timer);
    const latencyMs = Math.round(Date.now() - t0);
    // Read rate-limit headers from every response — even 429 tells us where we stand.
    const remaining = parseInt(res.headers.get("x-ratelimit-remaining") || "0", 10);
    const resetAt = parseInt(res.headers.get("x-ratelimit-reset") || "0", 10);
    if (res.status === 200) {
      // If remaining is 0 (or very close), we're exhausted even though this call went through.
      // Mark as "alive_but_exhausted" so scoring deprioritizes it.
      if (remaining <= 1) return { status: "alive_but_exhausted" as const, latencyMs, remaining, resetAt };
      return { status: "alive", latencyMs, remaining, resetAt };
    }
    if (res.status === 429) return { status: "throttled", latencyMs, remaining, resetAt };
    // 5xx is a dead API, not a dead key. The key is still valid and should stay
    // in the pool — probing it again later is cheap and it may well work then.
    // Collapsing this into "dead" would permanently discard a good key because
    // OpenSea had a bad minute.
    if (res.status >= 500) return { status: "server_error" as const, latencyMs, remaining, resetAt };
    // 401/403/404 and anything else: the key itself is the problem.
    return { status: "dead", latencyMs, remaining, resetAt };
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") return { status: "timeout", latencyMs: timeoutMs, remaining: -1, resetAt: 0 };
    return { status: "dead", latencyMs: Date.now() - t0, remaining: -1, resetAt: 0 };
  }
}

// ── Score a pool entry after probing ──────────────────────────────────────

export function computeScore(entry: KeyPoolEntry): number {
  const now = Date.now();
  // Higher = better.
  if (entry.last_probe === "dead") return -10000;
  if (entry.last_probe === "timeout") return 5;
  // The API was unreachable or erroring, not the key. Worth far more than a
  // timeout (the key is untested, not slow) but less than a confirmed-alive
  // key, because we have no evidence it works right now.
  if (entry.last_probe === "server_error") return 20;
  if (entry.last_probe === "throttled") {
    // 429 — actively rate-limited, can't use this call. Low score but keep
    // it in the pool; if reset time is recorded and in the future, it'll
    // recover and become useful again.
    if (entry.rate_limit_reset > 0 && entry.rate_limit_reset > now) {
      return 50; // will recover, but useless right now
    }
    return 30; // reset passed but still getting 429 — server hasn't caught up
  }
  if (entry.last_probe === "alive_but_exhausted") {
    // Got a 200 but remaining is 0 or 1. Still usable for THIS call (one
    // more shot before the window closes). Don't abandon it.
    if (entry.rate_limit_reset > 0 && entry.rate_limit_reset > now) {
      return 150; // one more call then it resets — valuable
    }
    return 100; // reset already passed but still at 0 — might recover, still try
  }
  // alive: base 1000 + remaining calls bonus - latency penalty - usage penalty
  return 1000 + Math.max(0, entry.remaining_calls) * 10 - Math.min(entry.probe_latency_ms, 2000) * 0.5 - entry.times_used * 20;
}

// ── Probe ALL keys in parallel, re-score, return sorted best→worst ──────

export async function probeAndRankPool(
  pool: KeyPoolEntry[]
): Promise<{ pool: KeyPoolEntry[]; best: KeyPoolEntry | null }> {
  if (pool.length === 0) return { pool: [], best: null };

  // Probe all in parallel — ~3s each, but all at once = ~3s total
  const probed = await Promise.all(
    pool.map(async (entry) => {
      const result = await probeKey(entry.api_key, 3000);
      // Persist the fresh quota numbers. Without this the entry keeps whatever
      // remaining_calls it had before — a stale value that can exceed the real
      // limit (observed: 598 stored vs 114 actual) and inflates the score by
      // thousands of points, letting a bad key outrank a good one.
      const refreshed: KeyPoolEntry = {
        ...entry,
        last_probe: result.status,
        last_probe_at: new Date().toISOString(),
        probe_latency_ms: result.latencyMs,
        remaining_calls: result.remaining,
        rate_limit_reset: result.resetAt,
      };
      refreshed.score = computeScore(refreshed);
      return refreshed;
    })
  );

  // Mark dead keys for removal (don't delete them, just deprioritize).
  // "alive_but_exhausted" is still usable but scored low — only picked if no
  // key with remaining calls exists.
  const usable = probed
    .filter((e) => e.last_probe === "alive" || e.last_probe === "alive_but_exhausted" || e.last_probe === "throttled" || e.last_probe === "server_error")
    .sort((a, b) => b.score - a.score);

  const best = usable.length > 0 ? usable[0] : null;
  return { pool: probed, best };
}

// ── Pick the best key (probes pool, returns winner) ──────────────────────

export async function pickBestKey(
  pool: KeyPoolEntry[]
): Promise<{ api_key: string; source: string; entry: KeyPoolEntry } | null> {
  const { pool: ranked, best } = await probeAndRankPool(pool);
  saveKeyPool(ranked); // persist scores

  if (!best) return null;

  // If best is throttled, note it but still use it (better than nothing).
  // Report remaining calls so the user knows if the key is near exhaustion.
  const remainingInfo = best.remaining_calls > 0
    ? `, ${best.remaining_calls} call(s) remaining`
    : best.last_probe === "alive_but_exhausted"
    ? ", EXHAUSTED (0 remaining)"
    : "";
  const source = best.last_probe === "alive"
    ? `alive (${best.probe_latency_ms}ms, used ${best.times_used}x${remainingInfo})`
    : best.last_probe === "alive_but_exhausted"
    ? `alive but exhausted${remainingInfo}`
    : best.last_probe === "throttled"
    ? `throttled (${best.probe_latency_ms}ms)${remainingInfo} — use with caution`
    : `probe: ${best.last_probe}`;

  return { api_key: best.api_key, source, entry: best };
}

// ── Add a freshly minted key to the pool ────────────────────────────────

export function addKeyToPool(
  meta: { api_key: string; name: string; expires_at: string }
): KeyPoolEntry {
  const pool = loadKeyPool();
  const entry: KeyPoolEntry = {
    api_key: meta.api_key,
    name: meta.name,
    expires_at: meta.expires_at,
    minted_at: new Date().toISOString(),
    times_used: 0,
    last_probe: "unknown",
    last_probe_at: "",
    probe_latency_ms: 0,
    score: 500,
    remaining_calls: -1, // unknown until first probe
    rate_limit_reset: 0,
  };
  pool.push(entry);
  saveKeyPool(pool);
  return entry;
}

// ── Remove a dead key from the pool ──────────────────────────────────────

export function removeKeyFromPool(apiKey: string): void {
  const pool = loadKeyPool();
  const filtered = pool.filter((e) => e.api_key !== apiKey);
  saveKeyPool(filtered);
}

// ── Mint a fresh free key (ONE attempt, no retry) ────────────────────────

const mintFreeKey = async (
  timeoutMs = 8000
): Promise<{ api_key: string; name: string; expires_at: string } | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(FREE_KEY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Documented success is 201 Created. The previous code required exactly 200,
    // so every successfully minted key was discarded and the pool could never
    // refill itself. Accept any 2xx.
    if (res.status < 200 || res.status >= 300) {
      if (res.status === 429) {
        // Remember the failure so subsequent runs skip the POST entirely.
        // Retry-After is the server's own statement of when the window opens —
        // verified live as ~11.5 hours, which no fixed period would guess.
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        markQuotaExhausted(retryAfter);
        console.log(
          chalk.yellow(
            `  OpenSea: free key creation rate-limited — try again later.${
              retryAfter > 0 ? ` (retry after ${Math.round(retryAfter / 3600)}h)` : ""
            }`
          )
        );
      }
      return null;
    }
    const body = (await res.json()) as any;
    if (!body?.api_key) return null;
    return {
      api_key: body.api_key,
      name: body.name || "agent_free",
      expires_at: body.expires_at || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  } catch {
    return null;
  }
};

// ── Main entry point: get a valid key, probing pool first ────────────────

export async function getValidApiKey(
  _opts?: { timeoutMs?: number },
): Promise<{ api_key: string; source: string } | null> {
  const pool = loadKeyPool();

  // 1. If pool has keys, probe and pick the best — NON-BLOCKING (≤3s)
  if (pool.length > 0) {
    console.log(chalk.gray(`  OpenSea: probing ${pool.length} key(s) in pool...`));
    const result = await pickBestKey(pool);
    if (result) {
      // Increment usage counter for the chosen key
      const updated = result.entry;
      updated.times_used += 1;
      // Decrement remaining calls since we're about to use it
      if (updated.remaining_calls > 0) updated.remaining_calls -= 1;
      saveKeyPool(loadKeyPool().map((e) => (e.api_key === result.entry.api_key ? updated : e)));
      const remInfo = updated.remaining_calls > 0
        ? ` (${updated.remaining_calls} calls left before rate limit)`
        : ` -- EXHAUSTED, next mint will need a fresh key`;
      console.log(chalk.green(`  ✓ Using key: ${result.source}${remInfo}`));
      return { api_key: result.api_key, source: result.source };
    }
    console.log(chalk.yellow("  ⚠ No usable key in pool — all are dead, throttled, or exhausted."));
  }

  // 2. Pool empty or all dead — try to mint a fresh one, if today's quota allows.
  const poolForQuota = loadKeyPool();
  const createdToday = keysCreatedToday(poolForQuota);
  if (createdToday >= 2 || quotaExhaustedToday()) {
    if (createdToday >= 2) {
      console.log(
        chalk.yellow(
          `  ⚠ Daily key creation quota exhausted (${createdToday}/2 today).`
        )
      );
      console.log(
        chalk.gray(
          "    OpenSea free tier allows max 2 key creations per day per IP."
        )
      );
    } else {
      console.log(
        chalk.yellow(
          "  ⚠ Free key creation already failed today (rate-limited) — skipping the request."
        )
      );
    }
    console.log(chalk.gray("    Re-trying cached keys instead..."));
  } else {
    console.log(
      chalk.gray(
        `  OpenSea: attempting to mint a fresh free key (${2 - createdToday} creation(s) left today)...`
      )
    );
    const fresh = await mintFreeKey(8000);
    if (fresh) {
      const entry = addKeyToPool(fresh);
      console.log(
        chalk.green(
          `  ✓ New key minted: ${fresh.api_key.slice(0, 12)}... (expires ${fresh.expires_at})`
        )
      );
      // Quick probe to confirm it's alive
      const probe = await probeKey(fresh.api_key, 3000);
      entry.last_probe = probe.status;
      entry.last_probe_at = new Date().toISOString();
      entry.probe_latency_ms = probe.latencyMs;
      entry.remaining_calls = probe.remaining;
      entry.rate_limit_reset = probe.resetAt;
      entry.score = computeScore(entry);
      saveKeyPool(loadKeyPool().map((e) => (e.api_key === fresh.api_key ? entry : e)));
      return {
        api_key: fresh.api_key,
        source: `new (probe: ${probe.status}, ${probe.latencyMs}ms)`,
      };
    }
  }

  // 3. Couldn't mint — rate limited or network error.
  //    Re-probe cached keys: they may have recovered since last probe.
  console.log(chalk.gray("  OpenSea: can't mint new key — re-probing cached keys to check recovery..."));
  const cachedKeys = loadKeyPool();
  if (cachedKeys.length > 0) {
    const result = await pickBestKey(cachedKeys);
    if (result && result.entry.last_probe !== "dead") {
      console.log(chalk.green(`  ✓ Re-using cached key: ${result.entry.api_key.slice(0, 12)}... (status: ${result.entry.last_probe})`));
      const updated = result.entry;
      updated.times_used += 1;
      if (updated.remaining_calls > 0) updated.remaining_calls -= 1;
      saveKeyPool(cachedKeys.map((e) => (e.api_key === result.entry.api_key ? updated : e)));
      return { api_key: result.entry.api_key, source: `cached (re-probed: ${result.entry.last_probe})` };
    }
  }

  // 4. Still nothing — give up with informative message
  console.log(chalk.yellow("\n  ⚠ Cannot mint a new OpenSea API key."));
  console.log(chalk.yellow("  → You've hit the free-tier rate limit (max 2 keys/day) or there's a network issue."));
  console.log(chalk.gray("  → Without a key, the FCFS signed-payload path won't work."));
  console.log(chalk.gray("  → The public mint path does NOT need an OpenSea key — try that instead."));

  // Show what we know about cached keys — their reset times if available
  const cached = loadKeyPool();
  if (cached.length > 0) {
    console.log(chalk.gray(`  → ${cached.length} key(s) cached from previous runs:`));
    for (const entry of cached) {
      const statusLabel = entry.last_probe === "alive" ? chalk.green("alive")
        : entry.last_probe === "alive_but_exhausted" ? chalk.yellow("exhausted")
        : entry.last_probe === "throttled" ? chalk.yellow("throttled")
        : entry.last_probe === "server_error" ? chalk.gray("api error")
        : entry.last_probe === "timeout" ? chalk.gray("timeout")
        : chalk.red("dead");
      const resetInfo = entry.rate_limit_reset > 0
        ? ` (resets ${new Date(entry.rate_limit_reset).toLocaleTimeString()})`
        : "";
      console.log(chalk.gray(`      • ${entry.api_key.slice(0, 12)}... — ${statusLabel}${resetInfo}`));
    }
    console.log(chalk.gray("  → Keys with a future reset time will work again — try re-running then.\n"));
  } else {
    console.log(chalk.gray("  → No cached keys available.\n"));
  }

  console.log(chalk.gray("  → Wait until the rate-limit window resets, or paste an existing key.\n"));
  return null;
}

// ── Probe a key without touching the pool (standalone check) ────────────

export async function probeApiKey(
  apiKey: string,
  timeoutMs = 3000
): Promise<boolean> {
  const result = await probeKey(apiKey, timeoutMs);
  return result.status === "alive";
}
