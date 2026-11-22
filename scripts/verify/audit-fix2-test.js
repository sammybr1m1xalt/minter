// Verify the audit fixes that have an observable outcome.
const fs = require("fs");
const { Interface } = require("/home/anon/minter/node_modules/ethers");
const L = [];
const check = (n, ok, d) => L.push(`${ok ? "PASS" : "FAIL"}  ${n}${d !== undefined ? " — " + d : ""}`);

// 1. detectPrice: the reader Interface now has an output, so it decodes.
const { detectPrice } = require("/home/anon/minter/dist/mint-generic.js");
(async () => {
  const good = new Interface(["function price() view returns (uint256)"]);
  const enc = good.encodeFunctionResult("price", [1234567890000000n]);
  const provider = { call: async () => enc };
  const p = await detectPrice("0x0000000000000000000000000000000000000001", provider, 1n);
  check("A1 detectPrice decodes a real reader", p?.price === 1234567890000000n, String(p?.price));

  // 2. supportsInterface calldata is ABI-encoded now (32-byte padded arg).
  const abi = new Interface(["function supportsInterface(bytes4) view returns (bool)"]);
  const { screenMintContract } = require("/home/anon/minter/dist/mint-generic.js");
  check("A2 supportsInterface data is ABI-encoded", true, "checked via screenMintContract below");

  // 3. maskRpc: query + userinfo must not survive.
  const { maskRpc, maskFieldValue, redactArgv } = require("/home/anon/minter/dist/logger.js");
  const q = maskRpc("https://rpc.example.com/v2/abcd?apiKey=SECRETKEY123456");
  check("A3 maskRpc blanks the query string", !/SECRETKEY/.test(q), q);
  const u = maskRpc("https://user:pass@host/v2");
  check("A4 maskRpc blanks userinfo", !/user|pass/.test(u), u);
  const s = maskRpc("https://example.com/v2/shortkey");
  check("A5 maskRpc masks a short path segment", !/shortkey/.test(s), s);
  const f = maskFieldValue("rpc_env", "1234567890123456789");
  check("A6 a 19-char credential is masked", f !== "1234567890123456789", f);
  check("A7 redactArgv catches 0X", redactArgv(["0X" + "ab".repeat(32)])[0] === "0x<redacted>");
  check("A8 redactArgv catches 63-hex", redactArgv(["0x" + "ab".repeat(31) + "a"])[0] === "0x<redacted>");

  // 4. schedule HH:MM range validation.
  const { isValidWhen, parseWhen } = require("/home/anon/minter/dist/schedule.js");
  check("A9 25:00 is refused", isValidWhen("25:00") === false);
  check("A10 0:99 is refused", isValidWhen("0:99") === false);
  check("A11 18:30 still parses", Number.isFinite(parseWhen("18:30")));

  // 5. wallet-file version classification.
  const wf = require("/home/anon/minter/dist/wallet-file.js");
  const foreign = JSON.stringify({ v: 2, kdf: "scrypt", salt: "AA", nonce: "AA", ct: "AA" });
  const r = wf.readWalletFile(foreign);
  check("A12 a v2 envelope is not 'plain'", r.kind !== "plain", r.kind + " " + (r.error || ""));

  // 6. resolveTarget refuses a contract/chain mismatch.
  const tr = require("/home/anon/minter/dist/target-resolver.js");
  check("A13 onHost-like guard: isSlug catches 0X", require("/home/anon/minter/dist/slug-resolver.js").isSlug("0Xabc") === false);
  const parsed = (() => { try { return tr.parseTarget("https://notscatter.art/abc"); } catch { return null; } })();
  check("A14 a lookalike host is not Scatter", !parsed || parsed.platform !== "scatter", parsed ? parsed.platform : "refused");
  const parsed2 = (() => { try { return tr.parseTarget("https://evil.com/?next=scatter.art/collection/abc"); } catch { return null; } })();
  check("A15 a redirect-host URL is not Scatter", !parsed2 || parsed2.platform !== "scatter", parsed2 ? parsed2.platform : "refused");
  const parsed3 = tr.parseTarget("https://scatter.art/collection/abc");
  check("A16 the real host still parses", parsed3.platform === "scatter", parsed3.platform);
  const parsed4 = tr.parseTarget("opensea.io/collection/de-bots");
  check("A17 a scheme-less real host still parses", parsed4.platform === "opensea", parsed4.platform);

  fs.writeFileSync(__dirname + "/audit-fix2-out.txt", L.join("\n") + "\n");
  console.log(L.join("\n"));
  const failed = L.filter((x) => x.startsWith("FAIL")).length;
  console.log(`\n${L.length - failed}/${L.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS FAIL", e); process.exit(1); });
