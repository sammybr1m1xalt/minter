// Can the MintActionTimeline GraphQL surface state a stage at all?
// Probing the schema by validation error: a field that exists returns data or a
// subfield error, a missing one returns "Cannot query field".
import fs from "fs";
import crypto from "crypto";
import dns from "dns";
try { dns.setDefaultResultOrder("ipv4first"); } catch {}
const env = {};
for (const l of fs.readFileSync("/home/anon/minter/.env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const key = env.OPENSEA_API_KEY || "";
console.log("key len", key.length);

const URL = "https://gql.opensea.io/graphql";
const vars = {
  address: "0x0000000000000000000000000000000000000001",
  fromAssets: [{ asset: { chain: "base", contractAddress: "0x0000000000000000000000000000000000000000" } }],
  toAssets: [{ asset: { chain: "base", contractAddress: "0x7465E492a183F16C0805e57262898c7bec11808A", tokenId: "0" }, quantity: "1" }],
};

const BASE = `query MintActionTimelineQuery($address: Address! $fromAssets: [AssetQuantityInput!]! $toAssets: [AssetQuantityInput!]! $recipient: Address) { swap(address: $address fromAssets: $fromAssets toAssets: $toAssets recipient: $recipient action: MINT) { actions { __typename ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier } } } } errors { __typename } } }`;

async function probe(label, text) {
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-app-id": "os2-web",
        origin: "https://opensea.io",
        referer: "https://opensea.io/",
        ...(key ? { "X-API-KEY": key } : {}),
      },
      body: JSON.stringify({
        operationName: "MintActionTimelineQuery",
        query: text,
        variables: vars,
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await r.json().catch(() => null);
    const errs = (j?.errors || []).map((e) => e.message);
    const actions = j?.data?.swap?.actions || [];
    const sub = actions.map((a) => ({ t: a.__typename, keys: Object.keys(a).filter((k) => k !== "__typename") }));
    console.log(`${label}: http ${r.status} actions=${actions.length} ${JSON.stringify(sub).slice(0, 160)} errs=${JSON.stringify(errs).slice(0, 220)}`);
  } catch (e) {
    console.log(`${label}: THREW ${String(e?.message || e).slice(0, 200)}`);
  }
}

await probe("baseline", BASE);
await probe("bogus", BASE.replace("actions { __typename", "actions { __typename ... on MintAction { zzzBogusField }"));
for (const f of ["stageUuid", "stage", "dropStageUuid", "mintStageUuid", "stageIndex", "dropStageIndex", "label"]) {
  await probe(f, BASE.replace("actions { __typename", `actions { __typename ... on MintAction { ${f} }`));
}
