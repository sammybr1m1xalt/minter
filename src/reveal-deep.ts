// ── Deep reveal pointer discovery ────────────────────────────────────────────
//
// The old reveal scan asked three getters (baseURI, contractURI, tokenURI) and
// stopped. Real collections publish the id -> artwork pointer under dozens of
// other names, or only in an event. This module collects EVERY publicly stated
// pointer it can find from the verified ABI, then hands the CIDs back to the
// existing resolver. It only reads world-readable data.
//
// Bounded on purpose: a capped number of getter calls, one address hop, a
// limited log window. A scan that hangs on a bespoke contract is not a scan.

import { Interface, type JsonRpcProvider } from "ethers";
import { fetchAbi } from "./abi-mint";

export interface DeepPointers {
  /** Human-readable provenance for each pointer, e.g. "baseTokenURI()". */
  sources: string[];
  /** Raw strings returned by getters / events. */
  uris: string[];
  /** Normalised ipfs:// / ar:// pointers, paths preserved. */
  urisNormalised: string[];
  cids: string[];
  errors: string[];
}

const BARE_CID = /\b(Qm[A-Za-z0-9]{44,}|bafy[A-Za-z0-9]{40,})\b/g;
const IPFS_LINK = /ipfs:\/\/[A-Za-z0-9]+(?:\/[^\s"'<>)\]]*)?/g;
const AR_LINK = /ar:\/\/[A-Za-z0-9_-]+(?:\/[^\s"'<>)\]]*)?/g;
const GATEWAY_IPFS = /https?:\/\/[^\s"'<>)]+\/ipfs\/([A-Za-z0-9]+(?:\/[^\s"'<>)]*)?)/g;

/** Extract every URI-shaped pointer from arbitrary text, paths kept. */
export function extractUris(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const re of [IPFS_LINK, AR_LINK]) {
    for (const m of text.matchAll(re)) out.add(m[0]);
  }
  for (const m of text.matchAll(GATEWAY_IPFS)) out.add(`ipfs://${m[1]}`);
  for (const m of text.matchAll(BARE_CID)) out.add(`ipfs://${m[1]}`);
  return [...out];
}

/** A no-arg view getter whose answer could carry a pointer. */
export function isPointerGetter(name: string, outputs: any[], mutability: string): boolean {
  if (mutability !== "view" && mutability !== "pure") return false;
  if (outputs.length !== 1) return false;
  const t = String(outputs[0]?.type ?? "").toLowerCase();
  if (t !== "string" && t !== "bytes" && t !== "address") return false;
  return /(uri|metadata|reveal|renderer|cid|hash|image|animation|base|token)/i.test(name);
}

/** Events whose string payload could carry a metadata pointer. */
export function isPointerEvent(name: string, inputs: any[]): boolean {
  if (!/(uri|metadata|reveal|update|set|publish)/i.test(name)) return false;
  return inputs.some((i) => String(i.type).toLowerCase() === "string");
}

const MAX_GETTER_CALLS = 30;

// The address hop targets another contract, so probe standard getters with a
// separate interface regardless of what the NFT's own ABI happens to declare.
const HOP_IFACE = new Interface([
  "function contractURI() view returns (string)",
  "function metadataURI() view returns (string)",
  "function baseURI() view returns (string)",
]);

/** Bounded concurrency: a flat Promise.all over 30 getters throttles most RPCs. */
async function pooled<T, R>(items: T[], workers: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function readStringGetter(
  provider: JsonRpcProvider,
  iface: Interface,
  to: string,
  name: string,
  timeoutMs: number
): Promise<string | null> {
  try {
    const data = iface.encodeFunctionData(name, []);
    const raw = await Promise.race([
      provider.call({ to, data }),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("getter timeout")), timeoutMs)),
    ]);
    const [value] = iface.decodeFunctionResult(name, raw);
    if (typeof value === "string") return value;
    if (typeof value === "bigint") return value.toString();
    return null;
  } catch {
    return null;
  }
}

export async function collectDeepPointers(opts: {
  provider: JsonRpcProvider;
  chainId: number;
  contract: string;
  logScanBlocks: number;
  timeoutMs: number;
  etherscanKey?: string;
}): Promise<DeepPointers> {
  const out: DeepPointers = { sources: [], uris: [], urisNormalised: [], cids: [], errors: [] };
  const { provider, chainId, contract, logScanBlocks, timeoutMs } = opts;

  const abiResult = await fetchAbi(chainId, contract, {
    etherscanKey: opts.etherscanKey,
    timeoutMs: Math.min(timeoutMs, 15_000),
  });
  if (!abiResult.abi) {
    out.errors.push(`no verified ABI: ${abiResult.error ?? "unavailable"}`);
    return out;
  }
  let iface: Interface;
  try {
    iface = new Interface(abiResult.abi as any);
  } catch (e: any) {
    out.errors.push(`ABI could not be parsed: ${e?.message ?? e}`);
    return out;
  }

  // 1. No-arg getters. Prefer the ones whose name is most obviously a URI.
  const getters = iface.fragments
    .filter((f: any) => f.type === "function" && f.inputs.length === 0)
    .filter((f: any) => isPointerGetter(f.name, f.outputs, f.stateMutability))
    .sort((a: any, b: any) => {
      const score = (n: string) => (/uri/i.test(n) ? 0 : /metadata|reveal/i.test(n) ? 1 : 2);
      return score(a.name) - score(b.name);
    })
    .slice(0, MAX_GETTER_CALLS);

  const getterValues = await pooled(getters, 6, async (f: any) => ({
    name: f.name,
    type: String(f.outputs?.[0]?.type ?? "").toLowerCase(),
    value: await readStringGetter(provider, iface, contract, f.name, timeoutMs),
  }));
  const followUps: { address: string; source: string }[] = [];
  for (const g of getterValues) {
    if (!g.value) continue;
    out.sources.push(`${g.name}() -> ${g.value.slice(0, 160)}`);
    out.uris.push(g.value);
    // One hop only: a metadata renderer is a common indirection; chasing a
    // chain of addresses would make the scan unbounded.
    if (g.type === "address" && /^0x[0-9a-fA-F]{40}$/.test(g.value)) {
      followUps.push({ address: g.value, source: g.name });
    }
  }
  // The hop target is a DIFFERENT contract: checking the NFT's ABI for these
  // names skips every renderer that does not duplicate them. Probe the
  // standard getters directly instead; a missing one just reverts.
  const hopJobs = followUps.flatMap((hop) =>
    ["contractURI", "metadataURI", "baseURI"].map((name) => ({ hop, name }))
  );
  const hopValues = await pooled(hopJobs, 6, async ({ hop, name }) => ({
    hop, name, value: await readStringGetter(provider, HOP_IFACE, hop.address, name, timeoutMs),
  }));
  for (const h of hopValues) {
    if (!h.value) continue;
    out.sources.push(`${h.hop.source}() -> ${h.hop.address.slice(0, 10)}… .${h.name}() -> ${h.value.slice(0, 160)}`);
    out.uris.push(h.value);
  }

  // 2. Events with a string payload. Old scan only looked for printable
  // ipfs:// in raw hex; decoding by ABI catches CIDs emitted as plain strings.
  if (logScanBlocks > 0) {
    const events = iface.fragments.filter((f: any) => f.type === "event" && isPointerEvent(f.name, f.inputs));
    if (events.length) {
      try {
        const head = await provider.getBlockNumber();
        const from = Math.max(0, head - logScanBlocks);
        const eventLogs = await pooled(events, 4, async (ev: any) => {
          const topic = ev.topicHash;
          let logs: any[] = [];
          try {
            logs = await provider.getLogs({ address: contract, fromBlock: from, toBlock: head, topics: [topic] });
          } catch {
            // Etherscan V2 serves ranged getLogs on Ethereum where free RPCs
            // refuse them. Keep the fallback key-free when unavailable.
            const key = opts.etherscanKey;
            if (chainId !== 1 || !key) return { ev, logs };
            const q = new URLSearchParams({
              chainid: "1", module: "logs", action: "getLogs",
              fromBlock: String(from), toBlock: String(head), topic0: topic, apikey: key,
            });
            try {
              const r = await fetch(`https://api.etherscan.io/v2/api?${q}`, {
                signal: AbortSignal.timeout(timeoutMs),
              });
              const j: any = await r.json();
              if (j.status === "1" && Array.isArray(j.result)) logs = j.result;
            } catch {
              // A refused event sweep is not evidence the event never fired.
            }
          }
          return { ev, logs };
        });
        for (const { ev, logs } of eventLogs) {
          for (const log of logs) {
            try {
              const decoded = iface.decodeEventLog(ev, log.data, log.topics);
              const strings = decoded
                .map((v: any) => (typeof v === "string" ? v : null))
                .filter((v: string | null): v is string => v !== null);
              for (const val of strings) {
                out.sources.push(`${ev.name}@${log.blockNumber} -> ${val.slice(0, 160)}`);
                out.uris.push(val);
              }
            } catch {
              // Another event can share a topic prefix; ignore undecodable rows.
            }
          }
        }
      } catch (e: any) {
        out.errors.push(`event sweep unavailable: ${e?.message ?? e}`);
      }
    }
  }

  for (const uri of out.uris) {
    for (const link of extractUris(uri)) {
      out.urisNormalised.push(link);
      const cid = link.replace(/^ipfs:\/\//, "").replace(/^ar:\/\//, "").split("/")[0];
      if (cid) out.cids.push(cid);
    }
  }
  out.sources = [...new Set(out.sources)];
  out.uris = [...new Set(out.uris)];
  out.urisNormalised = [...new Set(out.urisNormalised)];
  out.cids = [...new Set(out.cids)];
  return out;
}
