"use strict";
/* The reveal scan must not dump 20KB data URIs into stdout. */
const C = require("/home/anon/minter/dist/reveal-scan-cli.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

const big = "data:application/json;base64," + "A".repeat(20000);
const shown = C.displayUri(big);
ok("data URI is shortened", shown.length < 160, `${shown.length} chars`);
ok("payload length is still reported", shown.includes("[20000 chars]"), shown);
ok("data URI prefix survives", shown.startsWith("data:application/json;base64,"));

const long = "https://gateway.example/ipfs/bafy" + "x".repeat(500);
const short = C.displayUri(long);
ok("long http URI is shortened", short.length < 160 && short.includes("(533 chars)"), short);
ok("short URI is untouched", C.displayUri("ipfs://bafy/1") === "ipfs://bafy/1");
ok("null is labelled", C.displayUri(null) === "(none)");

console.log(`\n--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
