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

// HH:MM is read in the MACHINE'S LOCAL timezone, the same zone the reports
// are printed in. A fixed offset made a time typed from the screen resolve to
// a different instant on hosts in other zones.
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

  // HH:MM — the next occurrence of that wall-clock time locally, matching
  // what the wizard prints. setHours rolls out-of-range values over into the
  // next day, so "25:00" and "0:99" are refused before we get here.
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) {
      throw new Error(`cannot parse time: "${spec}" (hours 0-23, minutes 0-59)`);
    }
    const d = new Date(nowMs);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= nowMs) {
      d.setDate(d.getDate() + 1);
      d.setHours(hh, mm, 0, 0); // re-apply across a DST boundary
    }
    return Math.floor(d.getTime() / 1000);
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


