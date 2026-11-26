"use strict";
/* Batch --snipe argument shapes. */
const S = require("/home/anon/minter/dist/snipe-cli.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

let a = S.parseArgs(["--snipe", "0xabc", "--token-id", "1,2,3", "--count", "2"]);
ok("comma-separated ids", a.tokenIds.join(",") === "1,2,3" && a.count === 2, JSON.stringify(a.tokenIds));
a = S.parseArgs(["--snipe", "0xabc", "1", "2", "3"]);
ok("positional ids", a.target === "0xabc" && a.tokenIds.join(",") === "1,2,3", JSON.stringify(a));
a = S.parseArgs(["--snipe", "0xabc", "--token-id", "1", "--token-id", "2"]);
ok("repeatable flag", a.tokenIds.join(",") === "1,2", JSON.stringify(a.tokenIds));
a = S.parseArgs(["--snipe", "0xabc", "1", "1", "2"]);
ok("duplicates removed", a.tokenIds.join(",") === "1,2", JSON.stringify(a.tokenIds));
a = S.parseArgs(["--snipe", "0xabc"]);
ok("no ids keeps picker mode", a.tokenIds.length === 0 && a.tokenId === null);

console.log(`\n--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
