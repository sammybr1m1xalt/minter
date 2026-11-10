// ── "When" parsing ─────────────────────────────────────────────────────────
//

// A user could not say "in 5m" or "2h" or "18:30"; only absolute timestamps worked.
// That is a whole scheduling interface missing, not a convenience.
//
// Accepted forms:
//   unix seconds  (10 digits)
//   unix ms       (13 digits)   ← Bug K: the TS port never handled this
//   ISO 8601      ("2026-11-07T18:30:00Z")
//   relative      ("in 30s", "30s", "5m", "2h", "1d")
//   wall clock    ("18:30" — next occurrence)
//
// Returns UNIX SECONDS, matching the rest of the codebase.

// The UI announces mint times in IST (time-format.ts), so a wall-clock time
// typed by the user must be read in that zone — not the server's local zone.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Parse a "when" spec into an absolute unix-seconds timestamp. */
export function parseWhen(spec: string, nowMs: number = Date.now()): number {
  const s = String(spec).trim().toLowerCase();

  // Relative: optional leading "in ".
  let m = s.match(/^(?:in\s+)?(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0];
    const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return Math.floor(nowMs / 1000) + n * mult[unit];
  }

  // Unix ms — 13 digits. Checked BEFORE seconds, because a 13-digit number
  // would otherwise be read as an absurd unix-seconds value (Bug K).
  if (/^\d{13}$/.test(s)) return Math.floor(Number(s) / 1000);
  // Unix seconds — 10 digits.
  if (/^\d{10}$/.test(s)) return Number(s);

  // HH:MM — the next occurrence of that wall-clock time in IST (UTC+5:30),
  // matching what the wizard prints. Reading it in the server's local zone
  // meant a user who typed the time shown on screen got a different instant.
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date(nowMs + IST_OFFSET_MS);
    d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
    let t = Math.floor((d.getTime() - IST_OFFSET_MS) / 1000);
    if (t * 1000 <= nowMs) t += 86400; // already passed today → tomorrow
    return t;
  }

  // ISO / Date-parseable.
  const parsed = Date.parse(spec);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);

  throw new Error(`cannot parse time: "${spec}"`);
}

/**
 * True when a spec parses. Useful for validating user input before committing
 * to a long wait.
 */
export function isValidWhen(spec: string): boolean {
  try {
    parseWhen(spec);
    return true;
  } catch {
    return false;
  }
}

/** Format a unix-seconds timestamp as a human-readable remaining duration. */
export function formatWait(unixSeconds: number, nowMs: number = Date.now()): string {
  const ms = unixSeconds * 1000 - nowMs;
  if (ms <= 0) return "now";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}
