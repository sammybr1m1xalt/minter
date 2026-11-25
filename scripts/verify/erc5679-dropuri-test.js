// ERC-5679 detection/selectors and the DropURIUpdated log decoder.
const M = require("/home/anon/minter/dist/mint-generic.js");
const D = require("/home/anon/minter/dist/dropuri-cli.js");
const { AbiCoder, id } = require("ethers");

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

// ── ERC-5679 ────────────────────────────────────────────────────────────────
for (const sig of ["safeMint(address,uint256,bytes)", "mint(address,uint256,bytes)"]) {
  const s = M.MINT_SIGNATURES.find((x) => x.sig === sig);
  ok(`${sig} present`, !!s);
  if (s) {
    ok(`${sig} selector is 4 bytes`, /^0x[0-9a-f]{8}$/.test(s.selector), s.selector);
    ok(`${sig} selector matches keccak`, s.selector === id(sig).slice(0, 10));
    const args = M.buildArgs(s, { to: "0x" + "11".repeat(20), amount: 1n });
    ok(`${sig} encodes data as 0x`, args && args[2] === "0x", String(args));
  }
}
const added = M.MINT_SIGNATURES.filter((s) => ["safeMint(address,uint256,bytes)", "mint(address,uint256,bytes)"].includes(s.sig));
ok("new selectors are the lowest weight", added.every((s) => s.weight < 18), added.map((s) => s.weight).join(","));
ok("no safeMintBatch (needs a caller-supplied id list)", !M.MINT_SIGNATURES.some((s) => s.sig.includes("safeMintBatch")));

// ── DropURIUpdated ──────────────────────────────────────────────────────────
ok(
  "topic0 computed from the real event declaration",
  D.DROP_URI_TOPIC0 === "0xa0295608d25b3033c2e2c41cbac8746c2d08767bcfde6d47fae1ed7ba1d32150",
  D.DROP_URI_TOPIC0
);
const uri = "ipfs://bafkreig5xi7wb5xmku4apzaclgvx4p2bf3yer7ltqz6adjvzccoxkulf2y";
const addr = "0x" + "31aC".toLowerCase().repeat(10).slice(0, 40);
const log = {
  topics: [D.DROP_URI_TOPIC0, "0x" + "0".repeat(24) + addr.slice(2)],
  data: AbiCoder.defaultAbiCoder().encode(["string"], [uri]),
  blockNumber: "0x191c7a8",
  transactionHash: "0xabc",
};
const decoded = D.decodeDropUriLog(log);
ok("log decoded", decoded !== null);
ok("uri decoded", decoded?.uri === uri, decoded?.uri);
ok("indexed nftContract decoded", decoded?.nftContract.toLowerCase() === addr.toLowerCase(), decoded?.nftContract);
ok("malformed log refused", D.decodeDropUriLog({ topics: [], data: "0x" }) === null);
let rangeRefused = false;
try {
  D.parseDropUriArgs(["--from-block", "10", "--to-block", "5"]);
} catch {
  rangeRefused = true;
}
ok("reversed block range refused", rangeRefused);

console.log(`\n--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
