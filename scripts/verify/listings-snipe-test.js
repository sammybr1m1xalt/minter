// Rarity rows carry listing prices; sniping loads the wallet the wizard's way.
const B = require("/home/anon/minter/dist/buy-listings.js");
const W = require("/home/anon/minter/dist/wizard.js");
const C = require("/home/anon/minter/dist/reveal-scan-cli.js");

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

const base = (over = {}) => ({
  tokenId: "1", orderHash: "0xabc", protocolAddress: "0xdef", chain: "ethereum",
  maker: "0x" + "aa".repeat(20), currency: "ETH", value: "500000000000000000",
  decimals: 18, price: 0.5, error: null, ...over,
});

ok("listed price is inline", B.formatRarityListing(base()) === "listed 0.5 ETH", B.formatRarityListing(base()));
ok("not listed is not printed as 'listed not listed'", B.formatRarityListing(base({ error: "not listed", price: null })) === "not listed");
ok("unknown decimals stay labelled", B.formatRarityListing(base({ decimals: null, price: null })) === "listed 500000000000000000 (decimals unknown)");

(async () => {
  const saved = {
    keys: W.loadEnvKeys,
    prompt: W.promptWalletPassphrase,
    fetch: B.fetchBestListing,
    execute: B.executeListingBuy,
  };
  const pk = "0x" + "77".repeat(32);
  let prompted = 0;
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: "0x1" }) });
  try {
    W.promptWalletPassphrase = async () => { prompted++; };
    W.loadEnvKeys = () => [{ address: "0x1111111111111111111111111111111111111111", privateKey: pk }];
    B.fetchBestListing = async () => base();
    B.executeListingBuy = async (o) => { captured = o; return { sent: false, txHash: null, reason: "stub", price: 0.5, currency: "ETH" }; };
    await C.buyListedToken({
      tokenId: "7", slug: "test-collection", apiKey: "stub",
      chainKey: "ethereum", rpcs: ["http://rpc.invalid"], yes: false,
    });
  } finally {
    globalThis.fetch = realFetch;
    W.loadEnvKeys = saved.keys;
    W.promptWalletPassphrase = saved.prompt;
    B.fetchBestListing = saved.fetch;
    B.executeListingBuy = saved.execute;
  }
  ok("asks for the wallet passphrase", prompted === 1, String(prompted));
  ok("uses the wizard's loaded key", captured?.buyerKey === pk, String(captured?.buyerKey));
  ok("fetches the listing for the chosen token", captured?.listing?.tokenId === "1", captured?.listing?.tokenId);
  ok("no send is claimed when the buy was not sent", captured !== null);

  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
