"use strict";
// Mint times get announced in IST, so every command prints them that way.
Object.defineProperty(exports, "__esModule", { value: true });
exports.toIST = toIST;
exports.istTimeToDate = istTimeToDate;
exports.formatRemaining = formatRemaining;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function toIST(date) {
    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    const day = ist.getUTCDate();
    const month = ist.getUTCMonth() + 1;
    const year = ist.getUTCFullYear();
    const hours = ist.getUTCHours();
    const minutes = ist.getUTCMinutes().toString().padStart(2, "0");
    const seconds = ist.getUTCSeconds().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    const h12 = hours % 12 || 12;
    return `${day}/${month}/${year}, ${h12}:${minutes}:${seconds} ${ampm}`;
}
// "21:05" → today at 21:05 IST, expressed as a UTC Date.
function istTimeToDate(hhmm) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!match)
        throw new Error(`Invalid time "${hhmm}" — use HH:MM (24-hour IST)`);
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (hh > 23 || mm > 59)
        throw new Error(`Invalid time "${hhmm}" — use HH:MM (24-hour IST)`);
    const todayIST = new Date(Date.now() + IST_OFFSET_MS);
    todayIST.setUTCHours(hh, mm, 0, 0);
    return new Date(todayIST.getTime() - IST_OFFSET_MS);
}
// Format a duration in milliseconds as "Xh Ym Zs", "Ym Zs", or "Zs".
function formatRemaining(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0)
        return `${h}h ${m}m`;
    if (m > 0)
        return `${m}m ${s}s`;
    return `${s}s`;
}
//# sourceMappingURL=time-format.js.map