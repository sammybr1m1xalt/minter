// ── --logger: read a run log and render it as something a human can scan ────
//
// The run logger (logger.ts) writes a complete record to
// .minter-logs/run-<ts>-<pid>-<label>.log, but that file is a dump: header,
// every field, every message, the diagnostics block, the environment. Finding
// what happened means reading all of it.
//
// `--logger [file|-]` prints the same record digested — the fields that matter,
// the warnings and errors pulled out of the message stream, and the diagnostics
// count — so a run can be reviewed without opening the file.
//
// Input that is not a run log (a piped stdout, say) is digested generically:
// warnings and errors surfaced, then the lines grouped by the wallets they
// mention.

import * as fs from "fs";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── Run-log parsing ─────────────────────────────────────────────────────────

export interface RunLogMessage {
  ts: string;
  level: string;
  msg: string;
}

export interface RunLog {
  header: Record<string, string>;
  fields: [string, string][];
  messages: RunLogMessage[];
  /** True when the DIAGNOSTICS block listed at least one error. */
  errorCount: number;
  environment: [string, string][];
}

const SECTION_RE = /^── (.+?) ─{2,}\s*$/;
const HEADER_LINE_RE = /^═{3,}$/;
const MESSAGE_RE = /^\[(.+?)\] \[(\w+)\] ([\s\S]*)$/;
const KV_RE = /^  (\S+)\s{2,}(.*)$/;

/** Section names whose `key  value` lines are fields rather than messages. */
const FIELD_SECTIONS = new Set(["Run fields", "Environment (masked)"]);

export function parseRunLog(raw: string): RunLog | null {
  const text = stripAnsi(raw);
  if (!text.includes("MINTER RUN LOG")) return null;

  const lines = text.split("\n");
  const header: Record<string, string> = {};
  const fields: [string, string][] = [];
  const environment: [string, string][] = [];
  const messages: RunLogMessage[] = [];

  // Header: the `Key:   value` lines between the two ═ rules.
  let i = 0;
  let seenRule = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (HEADER_LINE_RE.test(l)) {
      seenRule++;
      if (seenRule === 2) { i++; break; }
      continue;
    }
    if (seenRule === 1) {
      const m = l.match(/^  ([A-Za-z ]+?):\s+(.*)$/);
      if (m) header[m[1].trim()] = m[2].trim();
    }
  }

  let section = "";
  for (; i < lines.length; i++) {
    const l = lines[i];
    const sec = l.match(SECTION_RE);
    if (sec) { section = sec[1].trim(); continue; }

    const msg = l.match(MESSAGE_RE);
    if (msg) {
      messages.push({ ts: msg[1], level: msg[2], msg: msg[3] });
      continue;
    }
    if (FIELD_SECTIONS.has(section)) {
      const kv = l.match(KV_RE);
      if (kv) {
        const pair: [string, string] = [kv[1], kv[2].trim()];
        if (section === "Run fields") fields.push(pair);
        else environment.push(pair);
      }
    }
  }

  return {
    header,
    fields: dedupeFields(fields),
    messages,
    errorCount: messages.filter((m) => m.level === "ERROR").length,
    environment: dedupeFields(environment),
  };
}

/** Keep first-seen order, last-seen value: the log records some keys twice. */
function dedupeFields(pairs: [string, string][]): [string, string][] {
  const order: string[] = [];
  const values = new Map<string, string>();
  for (const [k, v] of pairs) {
    if (!values.has(k)) order.push(k);
    values.set(k, v);
  }
  return order.map((k) => [k, values.get(k) as string]);
}

// ── Rendering ───────────────────────────────────────────────────────────────

function ttl(header: Record<string, string>, fallback: string): string {
  return header["Label"] || header["Mode"] || fallback;
}

export function renderRunLog(log: RunLog): string {
  const out: string[] = [];
  const h = log.header;
  out.push(`MINTER RUN — ${ttl(h, "unknown run")}`);
  const meta: string[] = [];
  if (h["Mode"]) meta.push(`mode ${h["Mode"]}`);
  if (h["Elapsed"]) meta.push(`elapsed ${h["Elapsed"]}`);
  if (h["Run ID"]) meta.push(`run ${h["Run ID"]}`);
  if (meta.length > 0) out.push(`  ${meta.join("  ·  ")}`);
  out.push("");

  if (log.fields.length > 0) {
    out.push("  RUN FIELDS");
    for (const [k, v] of log.fields) out.push(`    ${k.padEnd(24)} ${v}`);
    out.push("");
  }

  const warns = log.messages.filter((m) => m.level === "WARN");
  const errors = log.messages.filter((m) => m.level === "ERROR");
  out.push(
    `  MESSAGES  ${log.messages.length}  ·  ${warns.length} warning(s)  ·  ${errors.length} error(s)  ·  ${log.errorCount} diagnostic(s)`,
  );

  // Warnings and errors are the point of reading a log; print them whole.
  for (const m of [...warns, ...errors]) {
    out.push(`    [${m.ts}] ${m.level}  ${oneLine(m.msg)}`);
  }
  if (warns.length === 0 && errors.length === 0) out.push("    (none)");
  out.push("");

  const infos = log.messages.filter((m) => m.level === "INFO");
  if (infos.length > 0) {
    out.push(`  INFO (${infos.length}, oldest first)`);
    for (const m of infos) out.push(`    [${m.ts}] ${oneLine(m.msg)}`);
    out.push("");
  }

  if (log.environment.length > 0) {
    out.push("  ENVIRONMENT (masked)");
    for (const [k, v] of log.environment) out.push(`    ${k.padEnd(24)} ${v}`);
    out.push("");
  }

  return out.join("\n");
}

function oneLine(s: string): string {
  return s.split("\n")[0];
}

// ── Free-form digest (piped stdout, older logs) ──────────────────────────────

const WARN_MARKERS = /⚠|✗|ERROR|error|failed|refused|throttl|rate-limited|not eligible/i;

export function renderFreeForm(raw: string): string {
  const text = stripAnsi(raw);
  const lines = text.split("\n");

  const flagged = lines.filter((l) => WARN_MARKERS.test(l));
  const wallets = groupByWallet(lines);

  const out: string[] = [];
  out.push(`MINTER LOG — ${lines.length} line(s), ${flagged.length} flagged, ${wallets.size} wallet(s)`);
  out.push("");

  out.push("  FLAGGED");
  if (flagged.length === 0) out.push("    (none)");
  for (const l of flagged.slice(0, 60)) out.push(`    ${l.trimEnd()}`);
  if (flagged.length > 60) out.push(`    … ${flagged.length - 60} more`);
  out.push("");

  if (wallets.size > 0) {
    out.push("  PER WALLET");
    for (const [addr, ls] of [...wallets.entries()].slice(0, 12)) {
      out.push(`    ${addr}  (${ls.length} line(s))`);
      for (const l of ls.slice(0, 6)) out.push(`      ${l.trim()}`);
      if (ls.length > 6) out.push(`      … ${ls.length - 6} more`);
    }
    out.push("");
  }

  const tail = lines.filter((l) => l.trim().length > 0).slice(-12);
  out.push("  TAIL");
  for (const l of tail) out.push(`    ${l.trimEnd()}`);
  out.push("");

  return out.join("\n");
}

/** Wallet-shaped tokens, full or truncated (`0x5b13…b108`). */
const WALLET_RE = /0x[a-fA-F0-9]{4,40}(?:…[0-9a-fA-F]{2,6})?/g;

function groupByWallet(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of lines) {
    for (const m of l.matchAll(WALLET_RE)) {
      const key = m[0].toLowerCase();
      const arr = out.get(key) ?? [];
      arr.push(l);
      out.set(key, arr);
    }
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

// No --help here on purpose: index.ts answers --help before dispatching, and a
// second copy of the usage text would drift from it.

/** Newest run log in .minter-logs/, or null when there is none. */
function newestRunLog(): string | null {
  try {
    const moduleDir = __dirname;
    const root = moduleDir.endsWith("dist") ? require("path").dirname(moduleDir) : moduleDir;
    const dir = require("path").resolve(root, ".minter-logs");
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith("run-") && f.endsWith(".log"))
      .sort()
      .reverse();
    return files.length > 0 ? require("path").join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

export async function runLoggerCli(args: string[]): Promise<number> {
  // `-` means stdin; anything else positional is a file. Flags are dropped.
  const positional = args.filter((a) => a === "-" || !a.startsWith("-"));
  const target = positional.length > 0 ? positional[positional.length - 1] : undefined;

  let file: string | null = target && target !== "-" ? target : null;
  if (!file && target !== "-") file = newestRunLog();

  const readStdin = (): Promise<string> => new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error("stdin is a terminal — pipe a run's output, or pass a file path."));
      return;
    }
    let out = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { out += chunk; });
    process.stdin.on("end", () => resolve(out));
    process.stdin.on("error", (e) => reject(e));
  });

  let raw: string;
  if (file) {
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e: any) {
      console.error(`❌ cannot read ${file}: ${e?.message ?? e}`);
      return 1;
    }
  } else {
    let piped: string;
    try {
      piped = await readStdin();
    } catch (e: any) {
      console.error(`❌ ${e?.message ?? e}`);
      return 1;
    }
    if (!piped.trim()) {
      console.error("❌ no log on stdin. Pipe a run's output, or pass a file path.");
      return 1;
    }
    raw = piped;
  }

  const parsed = parseRunLog(raw);
  console.log(parsed ? renderRunLog(parsed) : renderFreeForm(raw));
  if (file) console.log(`\n  source: ${file}`);
  return 0;
}
