"use strict";
// ── Run logger — captures every invocation with full diagnostic detail ───────
//
// Every run writes a log to .minter-logs/run-<timestamp>-<mode>.log.
// IMPORTANT: log.end() MUST be called in every exit path (success, error, abort)
// so the log is flushed and closed. The index.ts CLI entry points call log.end()
// in both the success and catch branches of each mode. If you add a new entry
// point, mirror that pattern — a missing log.end() leaves a partially-written
// log file and loses the run's diagnostic data.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRunLogger = createRunLogger;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Resolved lazily rather than at module load, so a caller that changes
// process.cwd() (tests, embedders) still lands in the directory it expects.
function logDir() {
    return path.resolve(process.cwd(), ".minter-logs");
}
function createRunLogger(opts) {
    try {
        fs.mkdirSync(logDir(), { recursive: true });
    }
    catch (e) {
        // fs.mkdirSync throws on failure; best-effort only
    }
    const lines = [];
    const fields = [];
    const errors = [];
    const start = Date.now();
    const mode = opts.mode;
    const label = opts.label || mode;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const runId = `${ts}-${process.pid}`;
    const logFile = path.join(logDir(), `run-${runId}-${label}.log`);
    const push = (level, msg) => {
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
    return {
        info(msg) { push("INFO", msg); },
        warn(msg) { push("WARN", msg); },
        error(msg) { push("ERROR", msg); },
        field(key, value) { fields.push([key, value]); },
        dumpError(err) {
            const msg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack || "" : "";
            errors.push({ msg, stack });
            push("DIAG", `FATAL: ${msg}\n${stack}`);
        },
        end() {
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
                for (const l of lines)
                    out += `${l}\n`;
                out += "\n";
            }
            if (errors.length > 0) {
                out += "── DIAGNOSTICS (errors) ──────────────────────────────────────\n";
                out += `  ${errors.length} error(s) during this run:\n\n`;
                for (let i = 0; i < errors.length; i++) {
                    const e = errors[i];
                    out += `  ── Error #${i + 1} ──\n`;
                    out += `  Message: ${e.msg}\n`;
                    if (e.stack)
                        out += `  Stack:\n${e.stack}\n`;
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
                    }
                    else {
                        out += `  ${k.padEnd(22)} ${v}\n`;
                    }
                }
            }
            out += "\n";
            try {
                fs.writeFileSync(logFile, out, "utf-8");
                const logs = fs.readdirSync(logDir())
                    .filter(f => f.startsWith("run-") && f.endsWith(".log"))
                    .sort()
                    .reverse();
                for (const old of logs.slice(50)) {
                    try {
                        fs.unlinkSync(path.join(logDir(), old));
                    }
                    catch { }
                }
            }
            catch (e) {
                process.stderr.write(`Failed to write log: ${e}\n`);
                process.stderr.write(out);
            }
        },
    };
}
function maskRpc(url) {
    if (!url)
        return "<empty>";
    try {
        const u = new URL(url);
        const segs = u.pathname.split("/").filter(Boolean);
        const masked = segs.map(s => /^[0-9a-fA-F]{32,}$/.test(s) ? "••••••••" : s);
        u.pathname = "/" + masked.join("/");
        return u.toString();
    }
    catch {
        if (url.length <= 8)
            return "••••••••";
        return `${url.slice(0, 4)}••••${url.slice(-4)}`;
    }
}
//# sourceMappingURL=logger.js.map