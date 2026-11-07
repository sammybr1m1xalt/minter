// End-to-end: does the fixed GQL inventory path return real drops for a live
// collection? Uses the compiled module and a real slug.
import { execSync } from "node:child_process";

execSync(
  `npx tsc src/opensea-gql.ts src/fcfs-drops.ts src/fcfs-mint.ts src/opensea-key.ts src/chains.ts src/seadrop-onchain.ts src/seadrop-public.ts src/opensea-session.ts src/logger.ts src/rpc-health.ts src/rpc-resolver.ts src/rpc-blast.ts src/local-mint.ts src/slug-resolver.ts src/nft-link.ts src/timer.ts src/connection-warmer.ts src/prompt.ts src/wizard-helpers.ts src/time-format.ts --outDir tests/.compiled --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --esModuleInterop`,
  { stdio: "pipe" },
);

const m = await import(`./.compiled/fcfs-drops.js?t=${Date.now()}`);

const slug = process.argv[2] || "collectr";
console.log("fetching inventory for slug:", slug);

const inv = await m.fetchAllActiveDrops(
  "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb",
  undefined,
  12000,
  slug,
);

console.log("drops found:", inv.drops.length, "| chainId:", inv.chainId, "| reason:", inv.notFoundReason ?? "none");
for (const d of inv.drops) {
  console.log("  uuid:", d.dropId);
  console.log("  type:", d.type, "| isPublic:", d.isPublicStage);
  console.log("  price:", d.mintPrice.toString(), "wei =", Number(d.mintPrice) / 1e18, "ETH");
  console.log("  start:", new Date(d.startTime * 1000).toISOString());
  console.log("  maxPerWallet:", d.maxTotalMintableByWallet);
}

if (inv.drops.length === 0) {
  console.log("\nFAIL: no drops returned");
  process.exit(1);
}
const d = inv.drops[0];
if (d.mintPrice !== 5600000000000000n) {
  console.log(`\nFAIL: expected 5600000000000000 wei, got ${d.mintPrice}`);
  process.exit(1);
}
if (d.isPublicStage !== true) {
  console.log("\nFAIL: PUBLIC_SALE should classify as public");
  process.exit(1);
}
console.log("\nPASS: live GQL inventory returns correctly-priced, correctly-classified drops");
