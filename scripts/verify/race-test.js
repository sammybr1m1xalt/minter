// Verify the GQL/REST payload race in fetchSignedPayload.
const realFetch = globalThis.fetch;
const RealResponse = Response;

const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const NFT = "0x2957e11e2acd231894308c8fa44a4e8132db93ed";
const WALLET = "0x" + "11".repeat(20);
const CALLDATA = "0x161ac21f" + "00".repeat(128);
const VALUE = "5600000000000000";

let gqlMode = "ok"; // ok | hang | throw
let gqlDelay = 0;
let restMode = "ok"; // ok | throw
let restDelay = 0;
let gqlCalls = 0;
let restCalls = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gqlBody = {
  data: { swap: { actions: [{ __typename: "MintAction", transactionSubmissionData: { to: SEADROP, data: CALLDATA, value: VALUE, chain: { networkId: "1" } } }] } },
};
const restBody = {
  chain: "ethereum", to: SEADROP, data: CALLDATA, value: VALUE,
  stage_uuid: "df3ed2cd-fd02-4f55-9ddf-a978a4f1368e", stage_type: "public_sale",
  stage_start_time: new Date(Date.now() + 60000).toISOString(),
  stage_end_time: new Date(Date.now() + 1200000).toISOString(),
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("gql.opensea.io")) {
    gqlCalls++;
    if (gqlMode === "throw") throw new Error("simulated GQL network failure");
    await sleep(gqlDelay);
    if (gqlMode === "hang") throw new Error("simulated GQL hang");
    return new RealResponse(JSON.stringify(gqlBody), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("api.opensea.io")) {
    restCalls++;
    if (restMode === "throw") throw new Error("simulated REST network failure");
    await sleep(restDelay);
    return new RealResponse(JSON.stringify(restBody), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url);
};

const { fetchSignedPayload } = require("/home/anon/minter/dist/fcfs-mint.js");

const lines = [];
const check = (n, ok, d) => lines.push(`${ok ? "PASS" : "FAIL"}  ${n}${d !== undefined ? " — " + d : ""}`);

async function run(label, cfg, opts) {
  gqlMode = cfg.gqlMode; gqlDelay = cfg.gqlDelay ?? 0;
  restMode = cfg.restMode; restDelay = cfg.restDelay ?? 0;
  gqlCalls = 0; restCalls = 0;
  const t0 = Date.now();
  const p = await fetchSignedPayload(NFT, 1, "key", {
    slug: "fixture", walletAddress: WALLET, chainKey: "ethereum",
    accessToken: opts.accessToken ?? null,
    timeoutMs: opts.timeoutMs ?? 4000,
  });
  const ms = Date.now() - t0;
  console.log(`  ${label}: ${ms}ms src=${p?.source ?? "none"} gql=${gqlCalls} rest=${restCalls}`);
  return { p, ms };
}

async function main() {
  // 1. GQL hangs, REST fast, token present -> REST wins, and fast.
  let r = await run("1 hung GQL + fast REST + token", { gqlMode: "hang", gqlDelay: 2500, restDelay: 200 }, { accessToken: "jwt" });
  check("R1 hung GraphQL is rescued by REST", r.p?.source === "rest", r.p?.source);
  check("R2 ...and returns before the hang would have", r.ms < 1500, `${r.ms}ms`);
  check("R3 both surfaces were probed", gqlCalls === 1 && restCalls === 1, `gql=${gqlCalls} rest=${restCalls}`);

  // 2. GQL fails outright -> REST still wins.
  r = await run("2 dead GQL + fast REST + token", { gqlMode: "throw", restDelay: 200 }, { accessToken: "jwt" });
  check("R4 dead GraphQL falls back to REST", r.p?.source === "rest", r.p?.source);

  // 3. GQL fast, REST slow -> GraphQL wins the race.
  r = await run("3 fast GQL + slow REST + token", { gqlDelay: 200, restDelay: 900 }, { accessToken: "jwt" });
  check("R5 GraphQL wins when it is faster", r.p?.source === "gql", r.p?.source);
  check("R6 ...and does not wait for REST", r.ms < 700, `${r.ms}ms`);

  // 4. Both dead -> null, bounded by the timeout (not a hang).
  r = await run("4 both dead + token", { gqlMode: "throw", restMode: "throw" }, { accessToken: "jwt", timeoutMs: 1200 });
  check("R7 both dead returns null", r.p === null, String(r.p?.source));
  check("R8 ...bounded, not hung", r.ms < 2500, `${r.ms}ms`);

  // 5. No token -> NO race: GraphQL is awaited first, then REST.
  r = await run("5 hung GQL + fast REST, no token", { gqlMode: "hang", gqlDelay: 1500, restDelay: 100 }, { accessToken: null });
  check("R9 no token still falls back to REST", r.p?.source === "rest", r.p?.source);
  check("R10 ...but sequentially, so it pays the hang", r.ms > 1400, `${r.ms}ms`);

  // 6. No token, GQL fine -> GraphQL, one REST call never made.
  r = await run("6 fine GQL, no token", { gqlDelay: 100, restDelay: 100 }, { accessToken: null });
  check("R11 no token, GraphQL wins", r.p?.source === "gql", r.p?.source);
  check("R12 ...and REST is not called", restCalls === 0, `rest=${restCalls}`);

  require("fs").writeFileSync(__dirname + "/race-out.txt", lines.join("\n") + "\n");
  console.log("\n" + lines.join("\n"));
  const failed = lines.filter((l) => l.startsWith("FAIL")).length;
  console.log(`\n${lines.length - failed}/${lines.length} passed`);
  globalThis.fetch = realFetch;
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS FAIL", e); process.exit(1); });
