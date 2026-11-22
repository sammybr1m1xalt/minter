// Verify the Scatter wiring against the LIVE Scatter API.
// Planning only — nothing is signed or broadcast.
import { createRequire } from "module";
const require = createRequire("/home/anon/minter/");
const { Wallet } = require("ethers");

const sc = await import("/home/anon/minter/dist/scatter.js");
const sm = await import("/home/anon/minter/dist/scatter-mint.js");

const lines = [];
const check = (n, ok, d) => lines.push(`${ok ? "PASS" : "FAIL"}  ${n}${d !== undefined ? " — " + d : ""}`);

const wallet = new Wallet("0x" + "88".repeat(32));

// ── unit helpers ───────────────────────────────────────────────────────────
check("U1 unitSizeOf defaults to 1", sc.unitSizeOf({ id: "x" }) === 1, sc.unitSizeOf({ id: "x" }));
check("U2 unitSizeOf reads the field", sc.unitSizeOf({ id: "x", unit_size: 5 }) === 5, sc.unitSizeOf({ id: "x", unit_size: 5 }));
check("U3 unitSizeOf ignores nonsense", sc.unitSizeOf({ id: "x", unit_size: 0 }) === 1, sc.unitSizeOf({ id: "x", unit_size: 0 }));
check("U4 isUnlimited sentinel", sc.isUnlimited(4294967295) === true && sc.isUnlimited(5) === false, "");

const now = Date.now();
check("U5 window open when no times", sc.listWindow({ id: "x", start_time: null, end_time: null }, now).open === true);
check("U6 window closed before start", sc.listWindow({ id: "x", start_time: new Date(now + 60000).toISOString() }, now).open === false);
check("U7 window closed after end", sc.listWindow({ id: "x", end_time: new Date(now - 1000).toISOString() }, now).open === false);
check("U8 window open inside", sc.listWindow({ id: "x", start_time: new Date(now - 1000).toISOString(), end_time: new Date(now + 60000).toISOString() }, now).open === true);

// price: "0.001" ETH with 18 decimals -> 1e15, not 1
check("U9 price 0.001 ETH -> 1e15", sc.listPriceBaseUnits({ token_price: "0.001", decimals: 18 }) === 1000000000000000n, String(sc.listPriceBaseUnits({ token_price: "0.001", decimals: 18 })));
check("U10 price 1111 with 16 decimals", sc.listPriceBaseUnits({ token_price: "1111", decimals: 16 }) === 11110000000000000000n, String(sc.listPriceBaseUnits({ token_price: "1111", decimals: 16 })));
check("U11 price 0 is free, not unknown", sc.listPriceBaseUnits({ token_price: "0", decimals: 18 }) === 0n, String(sc.listPriceBaseUnits({ token_price: "0", decimals: 18 })));
check("U12 garbage price is unknown", sc.listPriceBaseUnits({ token_price: "abc", decimals: 18 }) === null, String(sc.listPriceBaseUnits({ token_price: "abc", decimals: 18 })));

// native list beats an ERC20 list regardless of the numbers
const mixed = [
  { id: "erc", name: "ERC20 cheap", token_price: "0.000001", decimals: 18, currency_address: "0x" + "aa".repeat(20), currency_symbol: "CHEAP", start_time: null, end_time: null },
  { id: "eth", name: "PUBLIC (ETH)", token_price: "0.001", decimals: 18, currency_address: "0x" + "00".repeat(20), currency_symbol: "ETH", start_time: null, end_time: null },
];
check("U13 native list wins over ERC20", sc.pickBestList(mixed)?.id === "eth", sc.pickBestList(mixed)?.id);

// two native lists: cheapest wins
const twoNative = [
  { id: "b", name: "B", token_price: "0.02", decimals: 18, currency_address: null, currency_symbol: "ETH", start_time: null, end_time: null },
  { id: "a", name: "A", token_price: "0.01", decimals: 18, currency_address: null, currency_symbol: "ETH", start_time: null, end_time: null },
];
check("U14 cheapest native wins", sc.pickBestList(twoNative)?.id === "a", sc.pickBestList(twoNative)?.id);

// ── live API ───────────────────────────────────────────────────────────────
const collection = await sc.getScatterCollection("nockmilio");
check("L1 live collection resolves", !!collection, collection && `${collection.name} chain ${collection.chainId}`);
if (collection) {
  check("L2 chain id is Base", collection.chainId === 8453, String(collection.chainId));
  check("L3 minted < max (still live)", (collection.numItems ?? 0) < (collection.maxItems ?? 0), `${collection.numItems}/${collection.maxItems}`);

  const lists = await sc.getEligibleLists("nockmilio", wallet.address);
  check("L4 live lists returned", lists.length > 0, `${lists.length} list(s)`);
  if (lists.length > 0) {
    const best = sc.pickBestList(lists);
    check("L5 a list is selected", !!best, best && best.name);
    check("L6 wallet_limit captured", best && best.wallet_limit === 111, best && String(best.wallet_limit));
    check("L7 root captured", !!best?.root, best && best.root);
    check("L8 price is 1111 * 10^16", best ? sc.listPriceBaseUnits(best) === 11110000000000000000n : false, best && String(sc.listPriceBaseUnits(best)));

    const planned = await sm.planScatterMint({
      slug: "nockmilio",
      collection,
      wallet,
      quantity: 1,
    });
    check("L9 plan built", !!planned.plan, planned.reason);
    if (planned.plan) {
      const p = planned.plan;
      check("L10 one unit, one NFT", p.units === 1 && p.nfts === 1, `${p.units}/${p.nfts}`);
      check("L11 API quote matches the list price", p.paymentValue === 11110000000000000000n, String(p.paymentValue));
      check("L12 no quote mismatch reported", p.quoteMismatch === null, p.quoteMismatch);
      check("L13 one ERC20 to approve", p.erc20s.length === 1, `${p.erc20s.length}`);
      check("L14 ERC20 amount matches", p.erc20s[0]?.amount === 11110000000000000000n, p.erc20s[0] && String(p.erc20s[0].amount));
      check("L15 spender is the collection", p.spender.toLowerCase() === collection.address.toLowerCase(), p.spender);
      check("L16 mint target is the collection", p.to.toLowerCase() === collection.address.toLowerCase(), p.to);
      check("L17 value covers the native fee", p.value >= (p.nativeFeeValue ?? 0n), `${p.value} >= ${p.nativeFeeValue}`);
      check("L18 calldata is non-empty", p.data.startsWith("0x") && p.data.length > 10, `${p.data.slice(0, 12)}…`);
      console.log("    plan: " + sm.describeScatterPlan(p));
    }

    // quantity above the wallet allowance must be refused, not silently clipped
    const greedy = await sm.planScatterMint({
      slug: "nockmilio",
      collection,
      wallet,
      quantity: 500,
    });
    check("L19 over-allowance quantity is refused", !greedy.plan, greedy.reason);
  }
}

// a list whose window has closed is refused, not minted into
if (collection) {
  const closed = await sm.planScatterMint({
    slug: "nockmilio",
    collection,
    wallet,
    quantity: 1,
    nowMs: Date.parse("2020-01-01T00:00:00Z"),
  });
  check("L20 a closed window is refused", !closed.plan, closed.reason);
}

import fs from "fs";
fs.writeFileSync(import.meta.dirname + "/scatter-out.txt", lines.join("\n") + "\n");
console.log(lines.join("\n"));
const failed = lines.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${lines.length - failed}/${lines.length} passed`);
process.exit(failed ? 1 : 0);
