"use strict";
/* RED harness: IPFS bytes are checked against the trusted CID, not gateway headers. */
const C = require("/home/anon/minter/dist/cid-verify.js");
const CID = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

const good = C.verifyIpfsBytes(CID, Buffer.from("hello world"));
ok("correct bytes verify", good === "verified", good);
const bad = C.verifyIpfsBytes(CID, Buffer.from("hello_world"));
ok("different bytes mismatch", bad === "mismatch", bad);
const nonsense = C.verifyIpfsBytes("not-a-cid", Buffer.from("hello world"));
ok("unparseable CID is unknown, not verified", nonsense === "unknown", nonsense);
const sha = C.verifyIpfsBytes("QmNonsense", Buffer.from("hello world"));
ok("CIDv0 parse failure is unknown", sha === "unknown", sha);

(async () => {
  const realFetch = globalThis.fetch;
  let url = null, init = null;
  globalThis.fetch = async (u, i) => {
    url = String(u); init = i;
    return { status: 200, ok: true, headers: { get: () => "application/vnd.ipld.raw" }, arrayBuffer: async () => Buffer.from("hello world").buffer.slice(0, 11) };
  };
  let v = await C.verifyIpfsDocument(CID, ["https://gateway.example"], 3000, 1024);
  ok("raw gateway fetch verifies", v.verdict === "verified", JSON.stringify(v));
  ok("uses format=raw with manual redirects", /\?format=raw/.test(url) && init?.redirect === "manual", url);

  globalThis.fetch = async () => ({ status: 200, ok: true, headers: { get: () => "application/vnd.ipld.raw" }, arrayBuffer: async () => Buffer.from("tampered").buffer.slice(0, 8) });
  v = await C.verifyIpfsDocument(CID, ["https://gateway.example"], 3000, 1024);
  ok("gateway-supplied wrong bytes mismatch", v.verdict === "mismatch", JSON.stringify(v));

  globalThis.fetch = async () => ({ status: 502, ok: false, headers: { get: () => "" } });
  v = await C.verifyIpfsDocument(CID, ["https://gateway.example"], 3000, 1024);
  ok("dead gateway is unknown, not mismatch", v.verdict === "unknown", JSON.stringify(v));

  globalThis.fetch = realFetch;
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
