// Exercise the reveal scanner against live contracts.
const fs = require("fs");
const { scanReveal } = require("/home/anon/minter/dist/reveal-scan.js");

const env = Object.fromEntries(
  fs.readFileSync("/home/anon/minter/.env", "utf8")
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);

const RPCS = Object.entries(env)
  .filter(([k]) => k.startsWith("RPC_URL_") && env[k])
  .map(([, v]) => v);

const CASES = [
  { name: "bayc (eth, revealed)", chainId: 1, rpcs: [env.RPC_URL_ETHEREUM], contract: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D" },
  { name: "shared storefront (erc1155)", chainId: 1, rpcs: [env.RPC_URL_ETHEREUM], contract: "0x495f947276749CE646f68AC8c248420045cb7b5e" },
  { name: "lagrange drop (eth clone)", chainId: 1, rpcs: [env.RPC_URL_ETHEREUM], contract: "0x2957e11e2acd231894308c8fa44a4e8132db93ed" },
];

(async () => {
  for (const c of CASES) {
    const t = Date.now();
    const r = await scanReveal({
      rpcUrls: c.rpcs.filter(Boolean),
      chainId: c.chainId,
      contract: c.contract,
      sampleTokenIds: [1, 2, 3, 100, 5000],
      logScanBlocks: 0,
    });
    console.log(`\n=== ${c.name} ${c.contract}  (${Date.now() - t}ms)`);
    console.log("  verdict:", r.verdict, " standard:", r.standard, " supply:", r.totalSupply);
    console.log("  baseURI:", r.baseURI, " slash:", r.revealedBySlash);
    console.log("  contractURI:", r.contractURI);
    console.log("  sampled:", r.sampledTokenUris.map((s) => `${s.tokenId}:${s.uri ? s.uri.slice(0, 46) : (s.error ?? "null")}`).join("  "));
    console.log("  distinct:", r.distinctTokenUris);
    for (const i of r.inspections) {
      console.log(`  cid ${i.cid.slice(0, 60)} -> ${i.kind} files=${i.fileCount} ${i.note ?? ""} ${i.sample.join(",")}`);
    }
    console.log("  findings:", r.findings);
    if (r.error) console.log("  ERROR:", r.error);
  }
})().catch((e) => { console.error("HARNESS FAIL", e); process.exit(1); });
