// Time reports must follow the machine's local timezone, not a fixed offset.
const { execFileSync } = require("child_process");

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`);
  }
};

const CHILD = `
const T = require('/home/anon/minter/dist/time-format.js');
const S = require('/home/anon/minter/dist/schedule.js');
const d = new Date('2026-11-25T14:00:00Z');
const p2 = (n) => String(n).padStart(2, '0');
const h12 = d.getHours() % 12 || 12;
const expected = p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear()
  + ', ' + h12 + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const now = Date.parse('2026-11-25T10:00:00Z');
const t = new Date(S.parseWhen('18:30', now) * 1000);
console.log(JSON.stringify({
  full: T.formatLocalTime(d),
  minute: T.formatLocalMinute(d),
  expected,
  whenIso: t.toISOString(),
  whenHour: t.getHours(),
  whenMinute: t.getMinutes(),
}));
`;

function runWithTz(tz) {
  const env = { ...process.env, TZ: tz };
  return JSON.parse(
    execFileSync(process.execPath, ["-e", CHILD], { env, encoding: "utf8" })
  );
}

const zones = ["Asia/Kolkata", "America/New_York", "Africa/Lagos"];
const results = {};
for (const tz of zones) {
  const r = runWithTz(tz);
  results[tz] = r;
  ok(`${tz}: report uses local wall clock`, r.full.startsWith(r.expected), r.full);
  ok(`${tz}: compact report uses local wall clock`, r.minute.startsWith(r.expected.slice(0, r.expected.lastIndexOf(":"))), r.minute);
  ok(`${tz}: HH:MM parses to local 18:30`, r.whenHour === 18 && r.whenMinute === 30, `${r.whenHour}:${r.whenMinute} (${r.whenIso})`);
}
const isos = new Set(zones.map((z) => results[z].whenIso));
ok("the same HH:MM is a different instant in each zone", isos.size > 1, [...isos].join(" "));
ok("zone label is shown in the report", /(?:[A-Z]{2,5}|GMT[+-]\d{1,2}(?::\d{2})?)$/.test(results["Asia/Kolkata"].full), results["Asia/Kolkata"].full);

console.log(`\n--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
