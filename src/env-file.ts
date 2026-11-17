// ── .env store ──────────────────────────────────────────────────────────────
//
// The project .env is the durable record of a choice made at a prompt. When a
// choice is not written back, it dies with the run and the next run silently
// uses the stale value — which is how a mint aimed at Robinhood was aimed at
// Ethereum, because .env still said CHAIN=ethereum.
//
// Only keys the user actually settled on belong here. Nothing is written on a
// read-only path (`--doctor`, `--eligibility`, `wallet …`).

import * as fs from "fs";
import * as path from "path";

/** The project .env, resolved the same way the loader resolves it. */
export function projectEnvPath(): string {
  const moduleDir = __dirname;
  const repoRoot = moduleDir.endsWith("dist") ? path.dirname(moduleDir) : moduleDir;
  return path.resolve(repoRoot, ".env");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Set one key in the project .env, preserving every other line including
 * comments and ordering. Atomic: written to a temp file and renamed, so a
 * crash cannot leave a half-written .env. The file is owner-only.
 */
export function setEnvValue(key: string, value: string): void {
  const file = projectEnvPath();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // Absent: create it.
  }
  const lines = text.length ? text.replace(/\n+$/, "").split("\n") : [];
  const re = new RegExp(`^${escapeRegExp(key)}=`);
  const next = `${key}=${value}`;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = next;
      found = true;
    }
  }
  if (!found) lines.push(next);

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw e;
  }
}

/**
 * Remember the chain the user settled on. Safe to call repeatedly and safe to
 * call when the value is unchanged — it only rewrites the file.
 */
export function rememberChain(chainKey: string): void {
  if (!chainKey) return;
  setEnvValue("CHAIN", chainKey);
}
