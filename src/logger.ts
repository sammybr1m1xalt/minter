// ── Run logger — captures every invocation with full diagnostic detail ───────
//
// Every run writes a log to
// .minter-logs/run-<timestamp>-<pid>-<label>.log, where <label> is the mint
// target (mode is a field inside the file, not part of the name).
// IMPORTANT: log.end() MUST be called in every exit path (success, error, abort)
// so the log is flushed and closed. The index.ts CLI entry points call log.end()
// in both the success and catch branches of each mode. If you add a new entry
// point, mirror that pattern — a missing log.end() leaves a partially-written
// log file and loses the run's diagnostic data.

import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";

// Resolved lazily rather than at module load, so a caller that changes
// process.cwd() (tests, embedders) still lands in the directory it expects.
//
// The logs belong to the TOOL, not to wherever the user happened to run it.
// Resolving against process.cwd() scattered them across every directory the
// CLI was invoked from ($HOME, /tmp, …) and left the repo's own .minter-logs/
// permanently empty. The repo root is one level above dist/ when compiled, or
// the source dir itself under ts-node.
function logDir(): string {
  const moduleDir = __dirname;
  const repoRoot = moduleDir.endsWith("dist") ? path.dirname(moduleDir) : moduleDir;
  return path.resolve(repoRoot, ".minter-logs");
}

export interface RunLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  field(key: string, value: string | number | boolean): void;
  dumpError(err: unknown, context?: Record<string, string>): void;
  end(): void;
}

// ── Active run logger ───────────────────────────────────────────────────────
//
// The CLI creates one run logger per invocation, but the fetch paths that have
// something worth recording live several modules away from it, and threading it
// through every signature would change far more code than it explains. A single
// active logger is the pragmatic middle: createRunLogger publishes it and say()
// writes through it.

let activeRunLogger: RunLogger | null = null;

/**
 * Write one line to both the live console and the run log.
 *
 * The console copy is what the operator reads while the run is in flight; the
 * run-log copy is what `--logger` reads afterwards. Emitting only to the log
 * hides it live, and only to the console loses it when the terminal scrolls.
 *
 * With an active run logger, warnings and errors are printed by the logger's
 * own stderr mirror — printing them here as well would show every refusal
 * twice. Without one (an embedder, a script), everything goes to stdout.
 */
export function say(msg: string, level: "info" | "warn" | "error" = "info"): void {
  const logger = activeRunLogger;
  if (logger) logger[level](msg);
  if (!logger || level === "info") {
    console.log(level === "error" ? chalk.red(msg) : level === "warn" ? chalk.yellow(msg) : chalk.gray(msg));
  }
}

export function createRunLogger(opts: { mode: string; label?: string }): RunLogger {
  try { fs.mkdirSync(logDir(), { recursive: true, mode: 0o700 }); } catch (e) {
    // fs.mkdirSync throws on failure; best-effort only
  }

  const lines: string[] = [];
  const fields: [string, string | number | boolean][] = [];
  const errors: { msg: string; stack: string }[] = [];
  const start = Date.now();
  const mode = opts.mode;
  const label = opts.label || mode;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = `${ts}-${process.pid}`;
  const logFile = path.join(logDir(), `run-${runId}-${safeLogLabel(label)}.log`);

  const push = (level: string, msg: string) => {
    const t = new Date().toISOString();
    lines.push(`[${t}] [${level}] ${msg}`);
    if (level === "ERROR") {
      const err = new Error(msg);
      errors.push({ msg, stack: err.stack || "" });
    }
    if (level === "ERROR" || level === "WARN") {
      // Mirror to stderr for visibility during the run
      process.stderr.write(`\n${msg}\n`);
    }
  };

  const logger: RunLogger = {
    info(msg) { push("INFO", msg); },
    warn(msg) { push("WARN", msg); },
    error(msg) { push("ERROR", msg); },
    field(key, value) { fields.push([key, maskFieldValue(key, String(value))]); },
    dumpError(err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack || "" : "";
      errors.push({ msg, stack });
      push("DIAG", `FATAL: ${msg}\n${stack}`);
    },
    end() {
      // No late say() may land in a logger that has already been flushed.
      activeRunLogger = null;
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      let out = "";
      out += `═══════════════════════════════════════════════════════════════\n`;
      out += `  MINTER RUN LOG\n`;
      out += `  Mode:      ${mode}\n`;
      out += `  Label:     ${label}\n`;
      out += `  Run ID:    ${runId}\n`;
      out += `  Elapsed:   ${elapsed}s\n`;
      out += `  Node:      ${process.version}\n`;
      out += `  Platform:  ${process.platform}\n`;
      out += `  CWD:       ${process.cwd()}\n`;
      out += `  Log file:  ${logFile}\n`;
      out += `  Invoked:   ${redactArgv(process.argv.slice(2)).join(" ")}\n`;
      out += `═══════════════════════════════════════════════════════════════\n\n`;

      if (fields.length > 0) {
        out += "── Run fields ────────────────────────────────────────────────\n";
        for (const [k, v] of fields) {
          out += `  ${k.padEnd(22)} ${v}\n`;
        }
        out += "\n";
      }

      if (lines.length > 0) {
        out += "── Messages ──────────────────────────────────────────────────\n";
        for (const l of lines) out += `${l}\n`;
        out += "\n";
      }

      if (errors.length > 0) {
        out += "── DIAGNOSTICS (errors) ──────────────────────────────────────\n";
        out += `  ${errors.length} error(s) during this run:\n\n`;
        for (let i = 0; i < errors.length; i++) {
          const e = errors[i];
          out += `  ── Error #${i + 1} ──\n`;
          out += `  Message: ${e.msg}\n`;
          if (e.stack) out += `  Stack:\n${e.stack}\n`;
          out += "\n";
        }
        out += `  ── End of diagnostics ──\n\n`;
      }

      out += "── Environment (masked) ──────────────────────────────────────\n";
      const envKeys = [
        "CHAIN", "RPC_URL", "RPC_URL_BASE", "RPC_URL_ETHEREUM",
        "RPC_URL_ROBINHOOD", "OPENSEA_API_KEY", "MAX_FEE_PER_GAS",
        "MAX_PRIORITY_FEE", "GAS_LIMIT", "NODE_ENV",
      ];
      for (const k of envKeys) {
        const v = process.env[k];
        if (v !== undefined) {
          if (k.includes("KEY") || k.includes("RPC") || k.includes("URL")) {
            out += `  ${k.padEnd(22)} ${maskRpc(String(v))}\n`;
          } else {
            out += `  ${k.padEnd(22)} ${v}\n`;
          }
        }
      }
      out += "\n";

      try {
        fs.writeFileSync(logFile, out, { encoding: "utf-8", mode: 0o600 });
        const logs = fs.readdirSync(logDir())
          .filter(f => f.startsWith("run-") && f.endsWith(".log"))
          .sort()
          .reverse();
        for (const old of logs.slice(50)) {
          try { fs.unlinkSync(path.join(logDir(), old)); } catch {}
        }
      } catch (e) {
        process.stderr.write(`Failed to write log: ${e}\n`);
        process.stderr.write(out);
      }
    },
  };
  activeRunLogger = logger;
  return logger;
}

/**
 * Run fields are written verbatim, so a field whose value is a credential must
 * be masked here. The error-dump env block already masked its values, but
 * `field()` did not — and `rpc_env` put a full Alchemy URL, key included, into
 * every log file on disk.
 */
const CREDENTIAL_FIELD = /key|token|secret|private|rpc|auth|password|seed|mnemonic/i;

/**
 * The command line as invoked, with anything key-shaped blanked out. A log
 * that records only the PARSED result cannot answer "why did it target that" —
 * the arguments are the first thing needed.
 */
export function redactArgv(args: string[]): string[] {
  // Case-insensitive, and not exactly-64-only: "0X…" is the same credential, and
  // a 63-hex value was passed through verbatim. Anything address/key-shaped and
  // long is blanked.
  return args.map((a) => (/^0[xX][0-9a-fA-F]{63,64}$/.test(a) ? "0x<redacted>" : a));
}

export function maskFieldValue(key: string, value: string): string {
  if (!value || !CREDENTIAL_FIELD.test(key)) return value;
  // Only an explicit boolean/placeholder is safe regardless of length. The
  // previous `value.length < 20` bypass emitted ANY shorter credential
  // verbatim — a 19-char key reached the run log in clear.
  if (/^(true|false|<unset>|<empty>)$/i.test(value)) return value;
  return maskRpc(value);
}

/** Path segments that are structural, not credentials. */
const SAFE_PATH_SEGMENTS = new Set([
  "v1", "v2", "v3", "api", "json", "graphql", "collections", "tokens", "nfts",
]);

export function maskRpc(value: string): string {
  if (!value) return "<empty>";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    // Not a URL — a bare API key read from the environment. Echo none of it.
    return "********";
  }
  const segs = u.pathname.split("/").filter(Boolean);
  // Mask by allowlist, not by shape. The old heuristic only masked segments
  // that were >=32 hex or >=20 alphanumeric, so a short provider key
  // (`/v2/shortkey`) and any key containing "." / "+" / "$" passed through.
  const masked = segs.map((s) =>
    SAFE_PATH_SEGMENTS.has(s.toLowerCase()) || /^\d+$/.test(s) ? s : "********"
  );
  u.pathname = "/" + masked.join("/");
  // The query string and the userinfo were re-serialised verbatim by
  // toString(), so a key in `?apiKey=…` or `user:pass@` was logged in clear.
  u.search = "";
  u.username = "";
  u.password = "";
  return u.toString();
}

/**
 * Make a run label safe to use in a log filename.
 *
 * The label comes from the user's mint target, which is untrusted input.
 * Interpolating it raw let a target of "../../../tmp/x" write the run log
 * outside .minter-logs/ (path.join normalises the traversal).
 */
export function safeLogLabel(label: string): string {
  const cleaned = String(label)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/\.+/g, "_");
  return cleaned.slice(0, 80) || "run";
}
