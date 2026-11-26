"use strict";
/* `--snipe 3255` must be a token id, never a contract target. */
const S = require("/home/anon/minter/dist/snipe-cli.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

let a = S.parseArgs(["--reveal-scan", "0xabc", "--rarity", "--snipe", "3255"]);
ok("contract then positional id", a.target === "0xabc" && a.tokenId === "3255", JSON.stringify(a));
a = S.parseArgs(["--snipe", "3255", "0xabc"]);
ok("id before contract", a.target === "0xabc" && a.tokenId === "3255", JSON.stringify(a));
a = S.parseArgs(["--snipe", "0xabc", "--token-id", "7"]);
ok("explicit --token-id wins", a.target === "0xabc" && a.tokenId === "7", JSON.stringify(a));
a = S.parseArgs(["--snipe", "3255"]);
ok("id alone leaves target for prompt", a.tokenId === "3255" && a.target === null, JSON.stringify(a));
a = S.parseArgs(["--reveal-scan", "0xabc", "--snipe"]);
ok("no id keeps picker mode", a.target === "0xabc" && a.tokenId === null, JSON.stringify(a));

console.log(`\n--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
