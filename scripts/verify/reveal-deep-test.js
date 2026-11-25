// Deep reveal discovery: extract pointers from getters, address hops and events.
const A = require("/home/anon/minter/dist/abi-mint.js");
const D = require("/home/anon/minter/dist/reveal-deep.js");
const { Interface } = require("ethers");

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

// ── pure extraction ──────────────────────────────────────────────────────────
const CID = "bafybeigjlloztjdiflxubrfcz3wxuxqnrnhivbpfjtogied24frhbpmcje";
const text = `ipfs://${CID}/1.json and ar://arweave-id-1234567890 and https://gateway.test/ipfs/${CID}/7 and bare ${CID}`;
const links = D.extractUris(text);
ok("keeps the path on an ipfs link", links.includes(`ipfs://${CID}/1.json`), links.join(" "));
ok("finds ar:// links", links.some((l) => l.startsWith("ar://")));
ok("normalises gateway URLs to ipfs://", links.includes(`ipfs://${CID}/7`));
ok("finds a bare CID", links.includes(`ipfs://${CID}`));
ok("empty input yields nothing", D.extractUris(null).length === 0);
ok("getter filter accepts a URI getter", D.isPointerGetter("baseTokenURI", [{ type: "string" }], "view"));
ok("getter filter rejects a mutating function", !D.isPointerGetter("setBaseURI", [{ type: "string" }], "nonpayable"));
ok("event filter accepts a string payload", D.isPointerEvent("MetadataUpdated", [{ type: "string" }]));
ok("event filter rejects numeric events", !D.isPointerEvent("Transfer", [{ type: "uint256" }]));

// ── full discovery against a fake ABI + fake provider ───────────────────────
const abi = [
  { type: "function", name: "baseTokenURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "metadataRenderer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "event", name: "MetadataUpdated", inputs: [{ name: "uri", type: "string", indexed: false }] },
];
const iface = new Interface(abi);
const RENDERER = "0x" + "22".repeat(20);
const CID2 = "Qm" + "Y".repeat(44);
const ERC_CID = "bafy" + "Z".repeat(50);
const event = iface.getEvent("MetadataUpdated");
const eventData = iface.encodeEventLog(event, [`ipfs://${CID2}/9.json`]).data;

const provider = {
  async call(tx) {
    if (tx.to === RENDERER) {
      const ext = new Interface([
        "function contractURI() view returns (string)",
      ]);
      const p2 = ext.parseTransaction({ data: tx.data });
      if (p2?.name === "contractURI") return ext.encodeFunctionResult("contractURI", [`ipfs://${CID}`]);
      throw new Error("no data");
    }
    const parsed = iface.parseTransaction({ data: tx.data });
    if (!parsed) throw new Error("unknown selector");
    if (parsed.name === "baseTokenURI") return iface.encodeFunctionResult("baseTokenURI", [`ipfs://${ERC_CID}/`]);
    if (parsed.name === "metadataRenderer") return iface.encodeFunctionResult("metadataRenderer", [RENDERER]);
    if (tx.to === RENDERER) {
      const ext = new Interface([
        "function contractURI() view returns (string)",
      ]);
      const p2 = ext.parseTransaction({ data: tx.data });
      if (p2?.name === "contractURI") return ext.encodeFunctionResult("contractURI", [`ipfs://${CID}`]);
    }
    throw new Error("no data");
  },
  async getBlockNumber() {
    return 1000;
  },
  async getLogs(q) {
    if (q.topics?.[0] !== event.topicHash) return [];
    return [{ blockNumber: 999, transactionHash: "0xabc", data: eventData, topics: q.topics }];
  },
};

(async () => {
  const realFetchAbi = A.fetchAbi;
  A.fetchAbi = async () => ({ abi, source: "sourcify" });
  let result;
  try {
    result = await D.collectDeepPointers({
      provider,
      chainId: 1,
      contract: "0x" + "11".repeat(20),
      logScanBlocks: 50,
      timeoutMs: 5000,
    });
  } finally {
    A.fetchAbi = realFetchAbi;
  }
  ok("discovers the non-standard getter", result.sources.some((s) => s.startsWith("baseTokenURI()")), result.sources.join(" | "));
  ok("follows the renderer address", result.sources.some((s) => s.includes("metadataRenderer()") && s.includes("contractURI")), result.sources.join(" | "));
  ok("decodes a string event", result.sources.some((s) => s.startsWith("MetadataUpdated@999")), result.sources.join(" | "));
  ok("collects all three CIDs", [ERC_CID, CID, CID2].every((c) => result.cids.includes(c)), result.cids.join(" "));
  ok("keeps the event path", result.urisNormalised.includes(`ipfs://${CID2}/9.json`));
  ok("records no errors", result.errors.length === 0, result.errors.join(" "));
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
