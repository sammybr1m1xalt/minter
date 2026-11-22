// T-0 fire latency harness.
//
// Drives the REAL executeFcfsSnipe against:
//   • a fake JSON-RPC server (latency configurable per method)
//   • a fake OpenSea GQL + REST, injected by overriding globalThis.fetch
//
// so the network is controlled and the code under test is the shipped code.
//
// usage: node run.js <scenario> [wallets]
const http = require("http");
const { Wallet } = require("/home/anon/minter/node_modules/ethers");
const realFetch = globalThis.fetch;
const RealResponse = Response;

const GQL_DELAY = Number(process.env.GQL_DELAY ?? 0);
const REST_DELAY = Number(process.env.REST_DELAY ?? 0);
const GQL_MODE = process.env.GQL_MODE ?? "ok"; // ok | throw | status
const GQL_STATUS = Number(process.env.GQL_STATUS ?? 500);
const REST_MODE = process.env.REST_MODE ?? "ok"; // ok | throw | status
const RPC_DELAY = Number(process.env.RPC_DELAY ?? 0);
const SLOW_WALLETS = Number(process.env.SLOW_WALLETS ?? 0);
const SLOW_DELAY = Number(process.env.SLOW_DELAY ?? 6000);
const SLOW_FROM_CALL = Number(process.env.SLOW_FROM_CALL ?? 999);
// Mint supply, climbing so the supply-position wait can be exercised.
let supply = Number(process.env.SUPPLY_START ?? 0);
const SUPPLY_STEP = Number(process.env.SUPPLY_STEP ?? 10);
const SUPPLY_EVERY = Number(process.env.SUPPLY_EVERY ?? 1000);
setInterval(() => { supply += SUPPLY_STEP; }, SUPPLY_EVERY).unref?.();
const STAGE_UUID = process.env.STAGE_UUID ?? "df3ed2cd-fd02-4f55-9ddf-a978a4f1368e";
const EXPECTED_STAGE = process.env.EXPECTED_STAGE ?? ""; // empty = none
const EXPECTED_TYPE = process.env.EXPECTED_TYPE ?? ""; // empty = none
const EXPECTED_START = process.env.EXPECTED_START ?? ""; // UNIX seconds
const EXPECTED_END = process.env.EXPECTED_END ?? "";
const EXPECTED_INDEX = process.env.EXPECTED_INDEX ?? "";
const PHASE_FUTURE = process.env.PHASE_FUTURE === "1";
const T_OFFSET = Number(process.env.T_OFFSET ?? 150);
const GQL_FAIL_AFTER = Number(process.env.GQL_FAIL_AFTER ?? 0); // fail GQL after N calls
const GQL_FAIL_FIRST = Number(process.env.GQL_FAIL_FIRST ?? 0); // fail the first N GQL calls
const REST_FAIL_AFTER = Number(process.env.REST_FAIL_AFTER ?? 0);
let gqlCalls = 0, restCalls = 0;

const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const NFT = "0x2957e11e2acd231894308c8fa44a4e8132db93ed";
// public_sale mint calldata: selector + enough padding to look like a payload
const CALLDATA = process.env.CALLDATA ?? ("0x161ac21f" + "00".repeat(128));
const VALUE = "5600000000000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN_T0 = Date.now();

// ── fake OpenSea ────────────────────────────────────────────────────────────
const gqlBody = {
  data: {
    swap: {
      actions: [
        {
          __typename: "MintAction",
          transactionSubmissionData: {
            to: SEADROP,
            data: CALLDATA,
            value: VALUE,
            chain: { networkId: "1" },
          },
        },
      ],
    },
  },
};

const restBody = {
  chain: "ethereum",
  to: SEADROP,
  data: CALLDATA,
  value: VALUE,
  stage_uuid: STAGE_UUID,
  stage_type: "public_sale",
  stage_start_time: new Date(Date.now() + 60_000).toISOString(),
  stage_end_time: new Date(Date.now() + 1_200_000).toISOString(),
};

async function fakeOpensea(url, init) {
  const u = String(url);
  if (u.includes("opensea.io")) console.log("   [fetch +" + (Date.now()-RUN_T0) + "ms]", u.slice(0, 55), (init&&init.method)||"GET");
  if (u.includes("gql.opensea.io")) {
    gqlCalls++;
    const gqlDead = GQL_MODE === "throw" || (GQL_FAIL_AFTER > 0 && gqlCalls > GQL_FAIL_AFTER) || (GQL_FAIL_FIRST > 0 && gqlCalls <= GQL_FAIL_FIRST);
    if (gqlDead) throw new Error("simulated GQL network failure");
    if (GQL_MODE === "status") {
      return new RealResponse(JSON.stringify({ errors: [{ message: "simulated" }] }), {
        status: GQL_STATUS,
        headers: { "content-type": "application/json" },
      });
    }
    // No per-wallet discriminator is available on the wire (the fixture's GQL
    // call carries no minter), so "slow" is by call ordinal: every GQL call
    // after the first SLOW_FROM_CALL is delayed. With 2 wallets that makes one
    // of them a straggler, which is the mixed case under test.
    const minter = "";
    await sleep(GQL_DELAY + (gqlCalls > SLOW_FROM_CALL ? SLOW_DELAY : 0));
    return new RealResponse(JSON.stringify(gqlBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (u.includes("api.opensea.io")) {
    restCalls++;
    const restDead = REST_MODE === "throw" || (REST_FAIL_AFTER > 0 && restCalls > REST_FAIL_AFTER);
    if (restDead) throw new Error("simulated REST network failure");
    if (REST_MODE === "status") {
      return new RealResponse(JSON.stringify({ code: "NOT_MINTING" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    await sleep(REST_DELAY);
    return new RealResponse(JSON.stringify(restBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(url, init);
}

// ── fake JSON-RPC ───────────────────────────────────────────────────────────
const HEX = (n) => "0x" + n.toString(16);
const rpcLog = [];
// STALE_NONCE=1 models a wallet that sent something during the wait: the prewarm
// reads nonce 0, the network now expects 1, and the first blast is rejected.
const STALE_NONCE = process.env.STALE_NONCE === "1";
let nonceReads = 0;
let sends = 0;
const rpcServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const t0 = process.hrtime.bigint();
    await sleep(RPC_DELAY);
    let rpcReq;
    try { rpcReq = JSON.parse(body); } catch { rpcReq = { method: "?" }; }
    const isBatch = Array.isArray(rpcReq);
    const items = isBatch ? rpcReq : [rpcReq];
    const answer = (r) => {
      switch (r.method) {
        case "eth_chainId": return HEX(1);
        case "net_version": return "1";
        case "eth_blockNumber": return HEX(1);
        case "eth_getTransactionCount": return HEX(STALE_NONCE ? (nonceReads++ === 0 ? 0 : 1) : 0);
        case "eth_call": {
          // totalSupply() = 0x18160ddd. Climbs so the positional wait is testable.
          // The calldata lives in params[0], not on the request object.
          const callData = String(r?.params?.[0]?.data ?? r?.params?.[0]?.input ?? "");
          if (callData.slice(0, 10) === "0x18160ddd") {
            if (process.env.SUPPLY_DEBUG === "1") console.log("   [mock] totalSupply -> " + supply + " hex=0x" + supply.toString(16).padStart(64, "0"));
            return "0x" + supply.toString(16).padStart(64, "0");
          }
          return "0x";
        }
        case "eth_estimateGas": return HEX(250000);
        case "eth_gasPrice": return HEX(1e9);
        case "eth_maxPriorityFeePerGas": return HEX(1e9);
        case "eth_feeHistory":
          return { oldestBlock: "0x1", baseFeePerGas: [HEX(1e9), HEX(1e9)], gasUsedRatio: [0.5], reward: [[HEX(1e9)]] };
        case "eth_getCode": return "0x";
        case "eth_getBlockByNumber": {
          const z = "0x" + "00".repeat(32);
          return { number: HEX(1), hash: "0x" + "cd".repeat(32), parentHash: "0x" + "cd".repeat(32),
                   timestamp: HEX(Math.floor(Date.now() / 1000)), gasLimit: HEX(30000000), gasUsed: HEX(0),
                   transactions: [], baseFeePerGas: HEX(1e9), miner: "0x" + "00".repeat(20), difficulty: "0x0",
                   extraData: "0x", logsBloom: "0x" + "00".repeat(256), nonce: "0x0000000000000000",
                   sha3Uncles: z, stateRoot: z, transactionsRoot: z, receiptsRoot: z, uncles: [],
                   size: HEX(100), mixHash: z };
        }
        case "eth_sendRawTransaction": return "0x" + "ab".repeat(32);
        case "eth_getTransactionReceipt":
          return { status: "0x1", blockNumber: HEX(2), transactionHash: "0x" + "ab".repeat(32), gasUsed: HEX(21000), effectiveGasPrice: HEX(1e9), logs: [] };
        default: return null;
      }
    };
    const out = items.map((r) => {
      rpcLog.push({ method: r?.method ?? "?", ms: Number(process.hrtime.bigint() - t0) / 1e6, at: Date.now() });
      if (r?.method === "eth_sendRawTransaction" && STALE_NONCE && sends++ === 0) {
        const msg = STALE_NONCE === "1" ? "nonce too low" : "execution reverted: not eligible";
        return { jsonrpc: "2.0", id: r?.id ?? 1, error: { code: -32000, message: msg } };
      }
      return { jsonrpc: "2.0", id: r?.id ?? 1, result: answer(r) };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(isBatch ? out : out[0]));
  });
});

// ── run ─────────────────────────────────────────────────────────────────────
const KEYS = [
  "0x" + "11".repeat(32),
  "0x" + "22".repeat(32),
  "0x" + "33".repeat(32),
  "0x" + "44".repeat(32),
  "0x" + "55".repeat(32),
  "0x" + "66".repeat(32),
  "0x" + "77".repeat(32),
  "0x" + "88".repeat(32),
  "0x" + "99".repeat(32),
  "0x" + "aa".repeat(32),
];
// Wallets (from the end of the list) whose OpenSea payload is slow to arrive.
const slowAddrs = new Set(
  KEYS.slice(Math.max(0, KEYS.length - SLOW_WALLETS)).map((k) => new Wallet(k).address.toLowerCase())
);

async function main() {
  const wallets = Number(process.argv[3] ?? 1);
  await new Promise((r) => rpcServer.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;

  globalThis.fetch = fakeOpensea;
  const { executeFcfsSnipe } = require("/home/anon/minter/dist/fcfs-mint.js");

  const targetStart = new Date(Date.now() + T_OFFSET);
  const tCall = Date.now();
  const WAVE_LOG = process.env.WAVE_LOG === "1";
  const waveSeen = [];
  const out = await executeFcfsSnipe({
    onWave: (wave, results) => {
      if (!WAVE_LOG) return;
      waveSeen.push({ wave, at: Date.now() - tCall, n: results.length, ok: results.filter(r => r?.success).length });
      console.log("   [onWave] wave=" + wave + " t+" + (Date.now() - tCall) + "ms results=" + results.length + " success=" + results.filter(r=>r?.success).length);
    },
    fireOnSupplyReached: process.env.TARGET_TOKEN
      ? { tokenId: Number(process.env.TARGET_TOKEN), quantity: Number(process.env.TARGET_QTY ?? 1), timeoutMs: Number(process.env.SUPPLY_TIMEOUT ?? 120000), pollMs: 200 }
      : undefined,
    nftContract: NFT,
    quantity: 1,
    walletKeys: KEYS.slice(0, wallets),
    rpcUrls: [rpcUrl],
    maxFeePerGas: 20n * 10n ** 9n,
    maxPriorityFeePerGas: 1n * 10n ** 9n,
    gasLimit: 250000,
    targetStart,
    plan: null,
    openSeaApiKey: "test-key",
    slug: "latency-fixture",
    chainKey: "ethereum",
    chainId: 1,
    phaseOpensInFuture: PHASE_FUTURE,
    expectedStage: EXPECTED_STAGE || EXPECTED_TYPE || EXPECTED_START || EXPECTED_INDEX
      ? {
          uuid: EXPECTED_STAGE || null,
          type: EXPECTED_TYPE || null,
          startTime: EXPECTED_START ? Number(EXPECTED_START) : null,
          endTime: EXPECTED_END ? Number(EXPECTED_END) : null,
          index: EXPECTED_INDEX ? Number(EXPECTED_INDEX) : null,
        }
      : null,
  });
  const tEnd = Date.now();
  const t0 = targetStart.getTime();

  const ok = out.filter((r) => r?.success).length;
  const refused = out.filter((r) => !r?.success);
  console.log(JSON.stringify({
    scenario: process.argv[2],
    gql_calls: gqlCalls,
    rest_calls: restCalls,
    wallets,
    total_ms: tEnd - tCall,
    from_T0_ms: tEnd - t0,
    ok,
    refused: refused.map((r) => ({ i: r.walletIndex, err: String(r.error).slice(0, 110) })),
    rpc_calls: rpcLog.length,
    supply_reads: rpcLog.filter((c) => c.method === "eth_call").length,
    final_supply: supply,
    first_send_ms: (() => { const s = rpcLog.find((c) => c.method === "eth_sendRawTransaction"); return s ? s.at - t0 : null; })(),
    last_send_ms: (() => { const s = [...rpcLog].reverse().find((c) => c.method === "eth_sendRawTransaction"); return s ? s.at - t0 : null; })(),
    rpc_methods: rpcLog.reduce((a, c) => (a[c.method] = (a[c.method] || 0) + 1, a), {}),
    waves: waveSeen,
    rpc_log: rpcLog.map((c) => ({ m: c.method, ms: Math.round(c.ms * 10) / 10, at: c.at - targetStart.getTime() })),
  }, null, 2));
  rpcServer.close();
}

main().catch((e) => { console.error("HARNESS FAIL", e); process.exit(1); });
