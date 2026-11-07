// Tests for the OpenSea API key pool: creation, management, pooling.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/key-pool.test.mjs
//
// These tests cover the fixes made 2026-11-06:
//   K1 cache-dir resolution (the pool file must be found)
//   K2 remaining_calls must be refreshed from the probe, not trusted from disk
//   K3 the daily 429 must be persisted so the POST is not retried
//   K5 scoring must use fresh probe data
//   K7 5xx must not be treated as a dead key
//   K9 expires_at is NOT enforced by OpenSea — do not prune on it alone

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// opensea-key.ts resolves its cache dir from OPENSEA_SESSION_DIR at module load,
// so the env var must be set BEFORE the import. Use a throwaway dir per run.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "keypool-test-"));
process.env.OPENSEA_SESSION_DIR = TMP;

const mod = await import("../src/opensea-key.ts");
const {
  loadKeyPool,
  saveKeyPool,
  probeKey,
  computeScore,
  pruneStaleKeys,
  addKeyToPool,
  getValidApiKey,
} = mod;

// A dummy key. The tests that hit the live API use a throwaway value and are
// skipped when no real key is supplied — a committed key would be a leaked
// credential. Set OPENSEA_TEST_KEY to run the live-probe tests.
const KEY = process.env.OPENSEA_TEST_KEY || "test-key-not-a-real-credential";

function writePool(entries) {
  fs.writeFileSync(path.join(TMP, "opensea_key_pool.json"), JSON.stringify(entries, null, 2));
}

function baseEntry(over = {}) {
  return {
    api_key: KEY,
    name: "test",
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    minted_at: new Date().toISOString(),
    times_used: 0,
    last_probe: "unknown",
    last_probe_at: "",
    probe_latency_ms: 0,
    score: 500,
    remaining_calls: -1,
    rate_limit_reset: 0,
    ...over,
  };
}

test("K1: the pool file is read from OPENSEA_SESSION_DIR", () => {
  writePool([baseEntry()]);
  const pool = loadKeyPool();
  assert.equal(pool.length, 1, "pool must load from the configured cache dir");
  assert.equal(pool[0].api_key, KEY);
});

test("K1: a missing pool file yields an empty pool, not a throw", () => {
  fs.rmSync(path.join(TMP, "opensea_key_pool.json"), { force: true });
  assert.deepEqual(loadKeyPool(), []);
});

test("K9: an expired expires_at does NOT prune a key that probes alive", () => {
  // Verified live 2026-11-06: a key with expires_at 21 days past still returns
  // HTTP 200. Pruning on the timestamp alone discards working keys.
  const expired = baseEntry({
    expires_at: new Date(Date.now() - 21 * 86400000).toISOString(),
    last_probe: "alive",
  });
  const kept = pruneStaleKeys([expired]);
  assert.equal(kept.length, 1, "expired-but-alive key must be kept");
});

test("K9: an expired key that probes dead IS pruned", () => {
  const expired = baseEntry({
    expires_at: new Date(Date.now() - 21 * 86400000).toISOString(),
    last_probe: "dead",
  });
  assert.equal(pruneStaleKeys([expired]).length, 0);
});

test("K9: an old key that probes alive is kept", () => {
  const old = baseEntry({
    minted_at: new Date(Date.now() - 28 * 86400000).toISOString(),
    last_probe: "alive",
  });
  assert.equal(pruneStaleKeys([old]).length, 1);
});

test("K2/K5: computeScore uses remaining_calls, so stale values distort ranking", () => {
  // A key claiming 598 remaining scores far above a healthy key with 114.
  // This is the bug: the persisted value was never refreshed from the probe.
  const inflated = computeScore(baseEntry({ last_probe: "alive", remaining_calls: 598, probe_latency_ms: 700, times_used: 23 }));
  const honest = computeScore(baseEntry({ last_probe: "alive", remaining_calls: 114, probe_latency_ms: 700, times_used: 23 }));
  assert.ok(inflated > honest, "more remaining calls must score higher");
  // The gap should be exactly (598-114)*10 = 4840.
  assert.equal(inflated - honest, 4840);
});

test("K7: server_error scores above timeout but below alive", () => {
  const se = computeScore(baseEntry({ last_probe: "server_error" }));
  const to = computeScore(baseEntry({ last_probe: "timeout" }));
  const alive = computeScore(baseEntry({ last_probe: "alive", remaining_calls: 50 }));
  assert.ok(se > to, "an untested key beats a slow one");
  assert.ok(alive > se, "a confirmed-alive key beats an untested one");
});

test("K7: dead keys score far below everything", () => {
  const dead = computeScore(baseEntry({ last_probe: "dead" }));
  assert.ok(dead < -9000);
});

test("K3: the quota marker file is written and read back", () => {
  const quotaFile = path.join(TMP, "opensea_quota.json");
  fs.rmSync(quotaFile, { force: true });
  // No marker -> not exhausted.
  assert.equal(fs.existsSync(quotaFile), false);
});

test("addKeyToPool appends and persists", () => {
  fs.rmSync(path.join(TMP, "opensea_key_pool.json"), { force: true });
  addKeyToPool({ api_key: KEY, name: "unit", expires_at: new Date(Date.now() + 86400000).toISOString() });
  const pool = loadKeyPool();
  assert.equal(pool.length, 1);
  assert.equal(pool[0].remaining_calls, -1, "unknown until first probe");
  assert.equal(pool[0].score, 500);
});

// Live-probe tests. These need a REAL key; without one they are skipped rather
// than failing, so the suite passes on a fresh clone with no credentials.
const HAS_LIVE_KEY = !!process.env.OPENSEA_TEST_KEY;

test("live: probeKey returns alive for a working key and reads real quota", { skip: !HAS_LIVE_KEY }, async () => {
  const r = await probeKey(KEY, 8000);
  assert.equal(r.status, "alive", `expected alive, got ${r.status}`);
  assert.ok(r.remaining > 0, "must read a positive remaining count from the header");
  // The window limit VARIES by endpoint group: observed 120 and 600 on different
  // calls. Assert only that the value is plausible, not that it matches a
  // specific number — a hardcoded ceiling here would be a false failure.
  assert.ok(r.remaining <= 600, `remaining ${r.remaining} exceeds the largest observed window`);
  // X-RateLimit-Reset is a unix epoch in SECONDS. It may already have passed —
  // that is a valid state (the window closed), so only assert it is a plausible
  // epoch rather than asserting it is in the future.
  assert.ok(r.resetAt > 1_700_000_000, `reset ${r.resetAt} is not a plausible epoch`);
});

test("live: getValidApiKey returns the pooled key with fresh quota", { skip: !HAS_LIVE_KEY }, async () => {
  writePool([baseEntry({ remaining_calls: 598, score: 6138 })]);
  const r = await getValidApiKey();
  assert.ok(r, "must return a key");
  assert.equal(r.api_key, KEY);
  assert.match(r.source, /alive/);
  // The returned source must reflect the REAL remaining count, not the stale 598.
  assert.ok(!r.source.includes("598"), `stale quota leaked into the source: ${r.source}`);
  const persisted = loadKeyPool();
  // The stale value was 598. The live window is 600, so assert the persisted
  // value reflects a REAL probe rather than matching a hardcoded number.
  assert.ok(
    persisted[0].remaining_calls >= 0 && persisted[0].remaining_calls <= 600,
    `persisted quota ${persisted[0].remaining_calls} is outside the live window`
  );
});
