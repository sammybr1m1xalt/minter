// On-chain data: URIs are a real id -> metadata mapping, even with no CID.
const { Interface } = require("ethers");
const R = require("/home/anon/minter/dist/rarity.js");

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

const doc = (name, rare) => ({
  name,
  attributes: [
    { trait_type: "Stage", value: rare ? "Ghost" : "Base" },
    { trait_type: "Level", value: 7, display_type: "number" },
  ],
});
const b64 = (o) => "data:application/json;base64," + Buffer.from(JSON.stringify(o)).toString("base64");
const enc = (o) => "data:application/json," + encodeURIComponent(JSON.stringify(o));

ok("decodes base64 data URIs", R.decodeOnchainMetadata(b64(doc("one", true)))?.name === "one");
ok("decodes URL-encoded data URIs", R.decodeOnchainMetadata(enc(doc("two", false)))?.name === "two");
ok("plain http URI is not metadata", R.decodeOnchainMetadata("https://example.test/1.json") === null);
ok("malformed base64 yields nothing", R.decodeOnchainMetadata("data:application/json;base64,%%%%") === null);

const iface = new Interface(["function tokenURI(uint256) view returns (string)", "function uri(uint256) view returns (string)"]);
const contract = "0x" + "12".repeat(20);
const provider = {
  async getBlockNumber() { return 100; },
  async call(tx) {
    if (tx.to !== contract) throw new Error("wrong target");
    const parsed = iface.parseTransaction({ data: tx.data });
    if (parsed?.name !== "tokenURI") throw new Error("no such function");
    const id = Number(parsed.args[0]);
    if (id === 3) throw new Error("burned"); // honest failure, not a common token
    return iface.encodeFunctionResult("tokenURI", [b64(doc("token-" + id, id === 1))]);
  },
  destroy() {},
};

(async () => {
  const result = await R.crawlOnchainTraits({
    contract,
    rpcUrls: [],
    chainId: 1,
    totalSupply: 4,
    probeTokenId: 1,
    limit: 4,
    concurrency: 2,
    timeoutMs: 20_000,
    provider,
  });
  ok("scores the readable ids", result.tokens.length === 3, JSON.stringify(result.tokens.map((t) => t.tokenId)));
  ok("counts the unreadable id as failed, not common", result.failed === 1, String(result.failed));
  ok("reports the on-chain source", result.source === "onchain", result.source);
  ok("listed count is the supply", result.listed === 4, String(result.listed));
  ok("traits were parsed", result.tokens.every((t) => t.traits.some((x) => x.type === "Stage")));

  const withExtra = await R.crawlOnchainTraits({
    contract,
    rpcUrls: [],
    chainId: 1,
    totalSupply: 4,
    probeTokenId: 1,
    limit: 1,
    extraIds: [2, 4],
    concurrency: 2,
    timeoutMs: 20_000,
    provider,
  });
  ok("extra ids are crawled in the same pass", withExtra.tokens.map((t) => t.tokenId).join(",") === "1,2,4", withExtra.tokens.map((t) => t.tokenId).join(","));
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
