// ── Doctor ──────────────────────────────────────────────────────────────────
//
// One command that answers "will this tool work right now?" — key presence,
// wallet availability, OpenSea session validity, and RPC reachability per
// chain, in a single report.
//
// It exists because the failure mode of a mint bot is not a crash, it is a run
// that starts confidently and dies at T-0 for a reason that was knowable
// minutes earlier: an expired session, a dead RPC, a throttled key.
//
// Rules it keeps:
//   - READ-ONLY. It never logs in, never probes in a way that consumes quota
//     beyond one key check, and never writes a file. A doctor run must be
//     safe to run anywhere, including a machine with no wallet.
//   - SECRETS NEVER PRINT. Not keys, not RPC URLs with provider tokens in the
//     path, not private keys. Endpoints are shown by hostname only.
//   - A failure to check is reported as unknown, never as a pass. An
//     unreachable RPC is not a broken RPC.
//
// Exit code is 1 when any check fails, so it can gate a script.

import chalk from "chalk";
import fs from "fs";
import path from "path";
import { CHAINS, type ChainProfile } from "./chains";
import { resolveRpcsForChain, isBenignProbeError, isTransportProbeError } from "./rpc-resolver";
import { loadKeyPool, isKeyStale, keyLabel, probeKey } from "./opensea-key";
import { inspectStoredSessions } from "./opensea-session";
import { sessionDir, siweSessionsFile, legacySessionFile } from "./session-store";
import { loadEnvKeys } from "./wizard";

type Level = "ok" | "warn" | "fail" | "info";

interface Check {
  level: Level;
  label: string;
  detail?: string;
}

interface Section {
  title: string;
  checks: Check[];
}

const RPC_TIMEOUT_MS = 8000;

const ICON: Record<Level, string> = {
  ok: chalk.green("✓"),
  warn: chalk.yellow("⚠"),
  fail: chalk.red("✗"),
  info: chalk.gray("·"),
};

/** Short, unambiguous host for an endpoint. Never the full URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A URL that does not parse may be a bare credential; echo none of it.
    return "••••••••";
  }
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function relativeDays(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

// ── RPC probe ───────────────────────────────────────────────────────────────

interface RpcProbe {
  url: string;
  latencyMs: number | null;
  chainId: number | null;
  error: string | null;
  /** HTTP status, when the endpoint answered with one. */
  status: number | null;
  /** The endpoint did not answer — our timeout, or a transport failure. */
  unreachable: boolean;
}

async function probeRpc(url: string, timeoutMs: number): Promise<RpcProbe> {
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: controller.signal,
    });
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - t0);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        url,
        latencyMs,
        chainId: null,
        error: `HTTP ${res.status} (non-JSON response)`,
        status: res.status,
        unreachable: false,
      };
    }
    if (json.result) {
      return {
        url,
        latencyMs,
        chainId: parseInt(json.result, 16),
        error: null,
        status: res.status,
        unreachable: false,
      };
    }
    return {
      url,
      latencyMs,
      chainId: null,
      error: json.error?.message ?? "no result",
      status: res.status,
      unreachable: false,
    };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    return {
      url,
      latencyMs: null,
      chainId: null,
      error: message,
      status: null,
      // Our own abort, or a socket-level failure undici reported as a generic
      // "fetch failed". Both mean the endpoint did not answer, which is not a
      // verdict about the endpoint.
      unreachable:
        controller.signal.aborted || isTransportProbeError(message, e?.cause?.code),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify one probe against the chain it is supposed to serve.
 *
 * Mirrors `planRpcs`: an endpoint that answers with a different chain id is
 * wrong, a benign "method not allowed" is a send-only sequencer that still
 * belongs in the blast set, and a timeout is unknown rather than broken.
 */
function classifyProbe(
  probe: RpcProbe,
  expectedChainId: number
): { level: Level; detail: string; usable: boolean; blast: boolean } {
  if (probe.chainId === expectedChainId) {
    return {
      level: "ok",
      detail: `chainId ${probe.chainId}, ${probe.latencyMs}ms`,
      usable: true,
      blast: true,
    };
  }
  if (probe.chainId != null) {
    return {
      level: "fail",
      detail: `wrong chain — got ${probe.chainId}, expected ${expectedChainId}`,
      usable: false,
      blast: false,
    };
  }
  // A throttled endpoint is not a broken one, and it is certainly not a
  // blocker: other endpoints serve the same chain. It is dropped from this
  // run's blast set (matching planRpcs) and reported as a degraded path.
  if (probe.status === 429 || /rate limit|too many requests/i.test(probe.error ?? "")) {
    return {
      level: "warn",
      detail: "throttled (429) — dropped from this run's blast set",
      usable: false,
      blast: false,
    };
  }
  if (probe.unreachable) {
    return {
      level: "warn",
      detail: `unreachable just now — unknown, kept for the blast`,
      usable: false,
      blast: true,
    };
  }
  if (isBenignProbeError(probe.error ?? undefined)) {
    return {
      level: "info",
      detail: `send-only — rejects reads, kept for the blast`,
      usable: false,
      blast: true,
    };
  }
  return {
    level: "fail",
    detail: probe.error ?? "unreachable",
    usable: false,
    blast: false,
  };
}

// ── Sections ────────────────────────────────────────────────────────────────

function configSection(repoRoot: string): Section {
  const checks: Check[] = [];

  const envPath = path.join(repoRoot, ".env");
  if (fs.existsSync(envPath)) {
    checks.push({ level: "ok", label: ".env", detail: "present in the project" });
  } else {
    checks.push({
      level: "warn",
      label: ".env",
      detail: "not found — every value must come from the prompt or the environment",
    });
  }

  if (process.env.OPENSEA_API_KEY?.trim()) {
    checks.push({ level: "ok", label: "OPENSEA_API_KEY", detail: "set" });
  } else {
    checks.push({
      level: "warn",
      label: "OPENSEA_API_KEY",
      detail: "not set — a free key is auto-minted at run time, or paste one",
    });
  }

  if (process.env.ETHERSCAN_API_KEY?.trim()) {
    checks.push({ level: "ok", label: "ETHERSCAN_API_KEY", detail: "set" });
  } else {
    checks.push({
      level: "warn",
      label: "ETHERSCAN_API_KEY",
      detail: "not set — verified ABIs on chains Sourcify does not cover need it",
    });
  }

  checks.push({
    level: "info",
    label: "CHAIN",
    detail: process.env.CHAIN?.trim() || "unset (the wizard asks)",
  });

  if (process.env.RPC_TIMEOUT_MS?.trim()) {
    checks.push({
      level: "info",
      label: "RPC_TIMEOUT_MS",
      detail: process.env.RPC_TIMEOUT_MS.trim(),
    });
  }

  return { title: "CONFIG", checks };
}

function walletSection(): Section {
  const checks: Check[] = [];
  // Addresses only. loadEnvKeys returns private keys too, and nothing in this
  // report may be able to reach them.
  const wallets = loadEnvKeys();
  if (wallets.length === 0) {
    checks.push({
      level: "warn",
      label: "wallets",
      detail: "none loaded — set PRIVATE_KEY, PRIVATE_KEYS, or WALLETS_FILE (the wizard can paste one)",
    });
    return { title: "WALLETS", checks };
  }
  const sources = [
    process.env.PRIVATE_KEY?.trim() ? "PRIVATE_KEY" : null,
    process.env.PRIVATE_KEYS?.trim() ? "PRIVATE_KEYS" : null,
  ].filter(Boolean);
  if (!sources.length && (process.env.WALLETS_FILE || "wallets.json")) sources.push("wallets file");
  checks.push({
    level: "ok",
    label: "wallets",
    detail: `${wallets.length} loaded from ${sources.join(", ")}`,
  });
  for (const w of wallets) {
    checks.push({ level: "info", label: `  ${shortAddress(w.address)}`, detail: "ready" });
  }
  return { title: "WALLETS", checks };
}

async function keyPoolSection(): Promise<Section> {
  const checks: Check[] = [];
  const pool = loadKeyPool();

  checks.push({
    level: "info",
    label: "pool",
    detail: pool.length
      ? `${pool.length} key(s) in .minter-cache/opensea_key_pool.json`
      : "empty — no cached keys yet",
  });

  if (pool.length === 0) {
    if (process.env.OPENSEA_API_KEY?.trim()) {
      checks.push({
        level: "info",
        label: "env key",
        detail: "not pooled — it is used first when present",
      });
    }
    return { title: "OPENSEA KEY POOL", checks };
  }

  // Probe the best key live. The pool records the LAST known state, which for a
  // cached key can be days old; "will it work right now" needs a now-answer.
  // Only the best is probed: probing every key spends real quota on credentials
  // that would not be used.
  const best = [...pool].sort((a, b) => b.score - a.score)[0];
  const live = await probeKey(best.api_key);

  for (const entry of [...pool].sort((a, b) => b.score - a.score)) {
    const isBest = entry === best;
    const stale = isKeyStale(entry);
    const parts: string[] = [];
    let level: Level = "ok";

    if (isBest) {
      parts.push(`${live.status}${live.latencyMs ? `, ${live.latencyMs}ms` : ""} (just now)`);
      if (live.status === "alive") level = "ok";
      // "dead" is the only status that says the KEY is the problem. A timeout
      // or a server error says nothing about it — the request never arrived.
      else if (live.status === "dead") level = "fail";
      else level = "warn";
      if (live.remaining > 0) parts.push(`${live.remaining} call(s) left`);
      else if (live.remaining === 0) parts.push("0 calls left — exhausted");
    } else {
      parts.push(`${entry.last_probe}${entry.probe_latency_ms ? `, ${entry.probe_latency_ms}ms` : ""} (last probe)`);
      if (entry.last_probe === "alive") level = "ok";
      else if (entry.last_probe === "dead") level = "fail";
      else level = "warn";
    }
    if (stale) {
      parts.push("stale");
      level = "warn";
    }
    parts.push(`score ${entry.score}`);

    checks.push({ level, label: keyLabel(entry), detail: parts.join("  ") });
  }

  return { title: "OPENSEA KEY POOL", checks };
}

function sessionSection(): Section {
  const checks: Check[] = [];
  const jar = siweSessionsFile();

  checks.push({
    level: "info",
    label: "jar",
    detail: fs.existsSync(jar)
      ? `${path.basename(sessionDir())}/${path.basename(jar)}`
      : `${path.basename(sessionDir())}/${path.basename(jar)} (not created yet)`,
  });

  if (fs.existsSync(legacySessionFile())) {
    checks.push({
      level: "info",
      label: "legacy session",
      detail: "a single-session file exists alongside the per-wallet jar",
    });
  }

  const sessions = inspectStoredSessions();
  if (sessions.length === 0) {
    checks.push({
      level: "warn",
      label: "sessions",
      detail: "none cached — FCFS/allowlist eligibility needs a SIWE login per wallet",
    });
    return { title: "OPENSEA SESSIONS", checks };
  }

  const now = Math.floor(Date.now() / 1000);
  for (const s of sessions) {
    const parts: string[] = [];
    let level: Level = "ok";
    if (s.expired) {
      level = "fail";
      parts.push(`expired ${relativeDays(now - s.exp)} ago — needs a fresh SIWE login`);
    } else if (s.expKnown) {
      parts.push(`valid, expires in ${relativeDays(s.exp - now)}`);
    } else {
      level = "warn";
      parts.push("no expiry recorded — validity unknown until it is used");
    }
    parts.push(`${s.cookieCount} cookie(s)`);
    checks.push({ level, label: shortAddress(s.address), detail: parts.join("  ") });
  }

  return { title: "OPENSEA SESSIONS", checks };
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

async function rpcSections(): Promise<Section[]> {
  // Flatten every chain's endpoints into one job list, then probe with bounded
  // concurrency. Firing all of them at once saturates the host's network and
  // produces "unreachable" verdicts for endpoints that are merely slow — a
  // false alarm that teaches the user to ignore the report.
  const jobs: { chain: ChainProfile; url: string }[] = [];
  for (const chain of CHAINS) {
    for (const url of resolveRpcsForChain(chain.key).urls) {
      jobs.push({ chain, url });
    }
  }

  const probed = await mapLimit(jobs, 4, async (job) => ({
    ...job,
    probe: await probeRpc(job.url, RPC_TIMEOUT_MS),
  }));

  const byChain = new Map<string, RpcProbe[]>();
  for (const { chain, probe } of probed) {
    const list = byChain.get(chain.key) ?? [];
    list.push(probe);
    byChain.set(chain.key, list);
  }

  return CHAINS.map((chain) => {
    const checks: Check[] = [];
    const probes = byChain.get(chain.key) ?? [];
    let usable = 0;
    let blast = 0;
    for (const probe of probes) {
      const c = classifyProbe(probe, chain.chainId);
      if (c.usable) usable++;
      if (c.blast) blast++;
      checks.push({ level: c.level, label: hostOf(probe.url), detail: c.detail });
    }
    checks.push({
      level: blast > 0 ? "ok" : "fail",
      label: "blast set",
      detail:
        blast > 0
          ? `${blast} endpoint(s) would be fired at`
          : "no endpoint to fire at — a mint on this chain cannot broadcast",
    });
    // Being able to fire is not the same as being able to read. Every value a
    // mint depends on (nonce, gas, balance, simulation) comes from a read, so
    // an unverified chain id is a real degradation even when the blast set is
    // non-empty — but it is not a blocker.
    checks.push({
      level: usable > 0 ? "ok" : "warn",
      label: "verified",
      detail:
        usable > 0
          ? `${usable} endpoint(s) confirmed chainId ${chain.chainId}`
          : `no endpoint answered with chainId ${chain.chainId} — reads (nonce, gas, simulation) are unverified`,
    });
    if (blast === 0) {
      checks.push({
        level: "fail",
        label: "  fix",
        detail: `set RPC_URL_${chain.key.toUpperCase()} or fix the endpoints above`,
      });
    }
    return { title: `RPC — ${chain.key} (chainId ${chain.chainId})`, checks };
  });
}

// ── Report ──────────────────────────────────────────────────────────────────

/**
 * Run every check and print the report. Returns the process exit code:
 * 0 when nothing failed, 1 when at least one check did.
 */
export async function runDoctor(): Promise<number> {
  const repoRoot = path.resolve(__dirname, "..");

  console.log(chalk.bold("\n🧑‍⚕️  minter doctor\n"));

  // The key-pool section probes one key live; the RPC sections probe every
  // endpoint. Both are awaited before printing so the report is ordered.
  const sections: Section[] = [
    configSection(repoRoot),
    walletSection(),
    await keyPoolSection(),
    sessionSection(),
    ...(await rpcSections()),
  ];

  const tally: Record<Level, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  const failures: string[] = [];

  for (const section of sections) {
    console.log(chalk.bold(section.title));
    for (const check of section.checks) {
      tally[check.level]++;
      if (check.level === "fail") failures.push(`${section.title}: ${check.label} — ${check.detail ?? ""}`);
      const detail = check.detail ? chalk.gray(`  ${check.detail}`) : "";
      console.log(`  ${ICON[check.level]} ${check.label}${detail}`);
    }
    console.log();
  }

  console.log(
    chalk.bold("SUMMARY  ") +
      `${chalk.green(`${tally.ok} ok`)} · ${chalk.yellow(`${tally.warn} warn`)} · ${chalk.red(`${tally.fail} fail`)} · ${chalk.gray(`${tally.info} info`)}`
  );

  if (failures.length > 0) {
    console.log(chalk.red(`\n  ${failures.length} blocker(s) that will stop a run:`));
    for (const f of failures) console.log(chalk.red(`    • ${f}`));
    if (tally.warn > 0) {
      console.log(
        chalk.yellow(`\n  ${tally.warn} warning(s) — degraded paths, not blockers. See the sections above.`)
      );
    }
    console.log();
    return 1;
  }

  if (tally.warn > 0) {
    console.log(
      chalk.yellow("\n  Nothing is broken. Warnings above are degraded paths, not blockers.")
    );
    console.log();
    return 0;
  }

  console.log(chalk.green("\n  Everything checks out.\n"));
  return 0;
}
