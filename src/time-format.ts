// Every human-facing timestamp is rendered in the machine's LOCAL timezone.
// There is no fixed offset here: a host set to WAT, IST or EST reports its own
// wall clock, and the zone abbreviation is printed so the reader knows which.
//
// Machine-readable timestamps (ISO strings in API payloads and on-disk caches)
// intentionally stay UTC — they are not reports and must remain parseable.

const ZONE_FORMATTER =
  typeof Intl !== "undefined"
    ? new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    : null;

function zoneLabel(date: Date): string {
  if (!ZONE_FORMATTER) return "";
  try {
    return (
      ZONE_FORMATTER.formatToParts(date).find((p) => p.type === "timeZoneName")
        ?.value ?? ""
    );
  } catch {
    return "";
  }
}

function localParts(date: Date) {
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;
  return { day, month, year, h12, hours, minutes, seconds, ampm, zone: zoneLabel(date) };
}

/** Full local wall-clock stamp, e.g. "25/11/2026, 4:03:19 PM WAT". */
export function formatLocalTime(date: Date): string {
  const p = localParts(date);
  return `${p.day}/${p.month}/${p.year}, ${p.h12}:${p.minutes}:${p.seconds} ${p.ampm}${p.zone ? ` ${p.zone}` : ""}`;
}

/** Compact local stamp for table columns, e.g. "25/11/2026, 4:03 PM WAT". */
export function formatLocalMinute(date: Date): string {
  const p = localParts(date);
  return `${p.day}/${p.month}/${p.year}, ${p.h12}:${p.minutes} ${p.ampm}${p.zone ? ` ${p.zone}` : ""}`;
}

/** Format a duration in milliseconds as "Xh Ym Zs", "Ym Zs", or "Zs". */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
