// ── Invocation record ────────────────────────────────────────────────────────
//
// The run logger attaches after flag parsing, so a run that dies earlier — a
// wallet-file command, --doctor, or an abort at the passphrase prompt — leaves
// no trace at all. That is how a run can "happen" with nothing to read back.
//
// This is the safety net: one append-only line at the very start of main(),
// and one on exit. It carries the arguments as typed and the exit status, so
// "did I run it, and with what" is always answerable even when the full log
// never gets written. It is deliberately separate from the run logs — this
// file only ever grows, and `--logger` does not need to parse it.

import * as fs from "fs";
import * as path from "path";
import { redactArgv } from "./logger";

function logPath(): string {
  const moduleDir = __dirname;
  const repoRoot = moduleDir.endsWith("dist") ? path.dirname(moduleDir) : moduleDir;
  return path.resolve(repoRoot, ".minter-logs", "invocations.log");
}

/** Append one line. Never throws: a diagnostic must not stop a run. */
export function appendInvocation(line: string): void {
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString()}  ${line}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // No log directory, read-only disk — the run must still proceed.
  }
}

export function recordInvocationStart(argv: string[]): void {
  const args = redactArgv(argv).join(" ");
  appendInvocation(`START  ${args || "(no arguments)"}`);
}

export function recordInvocationEnd(code: number): void {
  appendInvocation(`EXIT   code=${code}`);
}
