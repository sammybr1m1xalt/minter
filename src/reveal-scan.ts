// ── Reveal / metadata-leak scan ──────────────────────────────────────────────
//
// Answers one question about a drop: is the id -> artwork mapping actually
// private, or is it already readable by anyone?
//
// Strictly public data. It reads the contract (baseURI / contractURI /
// tokenURI), resolves the IPFS or Arweave CIDs those return, and looks at what
// is already published. It never calls a non-public endpoint, never enumerates
// unpublished data, and never tries to reach something that is not already
// world-readable. A "PUBLIC" verdict means the drop is already leaked; it does
// not mean this code got around a control.
//
// Why the checks are ordered this way:
//
//   1. baseURI trailing slash — the reveal switch. SeaDrop appends the token id
//      only when baseURI ends in "/", so no slash means every token returns one
//      placeholder and there is no per-token metadata to find.
//   2. contractURI — often carries a metadata base or the token directory.
//   3. tokenURI(id) sample — if minted tokens already return DISTINCT metadata
//      while baseURI is hidden, the reveal happened by another route.
//   4. IPFS/Arweave resolution — the highest-value check. A CID that resolves
//      to a DIRECTORY of per-token JSONs is the full mapping, published, even
//      if the contract has not been "revealed". A CID that resolves to one JSON
//      is just the placeholder and reveals nothing.
//   5. log sweep — reveal transactions and metadata events carry the CID.
//
// Expected result for a genuine OpenSea Studio drop: HIDDEN. That is the
// correct answer, not a failure.

import { Interface, JsonRpcProvider } from "ethers";
import { collectDeepPointers, extractUris, type DeepPointers } from "./reveal-deep";

const META_IFACE = new Interface([
  "function baseURI() view returns (string)",
  "function contractURI() view returns (string)",
  "function tokenURI(uint256) view returns (string)",
  "function uri(uint256) view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
]);

export type RevealVerdict = "HIDDEN" | "PARTIAL" | "PUBLIC" | "UNKNOWN";

export interface RevealScanOptions {
  rpcUrls: string[];
  chainId: number;
  contract: string;
  /** Which tokenURI flavour to try. Detected automatically when omitted. */
  standard?: "erc721" | "erc1155";
  /** Token ids to sample for distinct-metadata. Default 1..5. */
  sampleTokenIds?: number[];
  /** Public IPFS gateways, tried in order. */
  ipfsGateways?: string[];
  /** How many recent blocks to sweep for metadata-like logs. 0 disables. */
  logScanBlocks?: number;
  timeoutMs?: number;
  /** ABI-driven pointer discovery: getters, address hops and metadata events. */
  deep?: boolean;
  etherscanKey?: string;
}

export interface IpfsInspection {
  cid: string;
  kind: "directory" | "file" | "unfetchable";
  fileCount: number;
  sample: string[];
  note?: string;
  /** A URL that actually serves this CID, so the finding is viewable. */
  url: string | null;
}

export interface RevealScanResult {
  contract: string;
  chainId: number;
  verdict: RevealVerdict;
  standard: "erc721" | "erc1155" | "unknown";
  baseURI: string | null;
  /** true = revealed (slash), false = hidden, null = could not read. */
  revealedBySlash: boolean | null;
  contractURI: string | null;
  totalSupply: string | null;
  sampledTokenUris: { tokenId: number; uri: string | null; error: string | null }[];
  distinctTokenUris: number;
  inspections: IpfsInspection[];
  logHits: { blockNumber: number; txHash: string; name: string; metadataLike: string[] }[];
  /** Deep-discovery provenance: where each extra pointer came from. */
  deepPointers: DeepPointers | null;
  findings: string[];
  error: string | null;
}

async function callString(
  provider: JsonRpcProvider,
  to: string,
  sig: string,
  args: any[] = []
): Promise<string | null> {
  try {
    const data = META_IFACE.encodeFunctionData(sig, args);
    const raw = await (provider as any).call({ to, data });
    const [value] = META_IFACE.decodeFunctionResult(sig, raw);
    return value as string;
  } catch {
    return null;
  }
}

function callBig(provider: JsonRpcProvider, to: string, sig: string, args: any[] = []): Promise<bigint | null> {
  const data = META_IFACE.encodeFunctionData(sig, args);
  return (provider as any)
    .call({ to, data })
    .then((raw: string) => (META_IFACE.decodeFunctionResult(sig, raw)[0] as bigint) ?? null)
    .catch(() => null);
}

// Public gateways, tried in order. ipfs.io and dweb.link rate-limit aggressively
// from a single IP (measured 429 on a handful of requests) and cloudflare-ipfs
// is often unreachable, so a hard-coded single gateway would report a
// perfectly public CID as "unfetchable".
export const DEFAULT_GATEWAYS = [
  "https://ipfs.io/ipfs",
  "https://gateway.pinata.cloud/ipfs",
  "https://w3s.link/ipfs",
  "https://dweb.link/ipfs",
  // Measured: these four can ALL 429 in the same minute. gw3.io answered 200
  // while the others refused, so a fifth is the difference between "runs" and
  // "reports UNKNOWN". Add more as they prove themselves.
  "https://gw3.io/ipfs",
];

/** How much of a directory index to read before deciding it is one. */
const MAX_INDEX_BYTES = 262_144;

export async function inspectPublicCid(
  cid: string,
  gateways: string[] = DEFAULT_GATEWAYS,
  timeoutMs = 20_000
): Promise<IpfsInspection> {
  const bare = cid.replace(/^ipfs:\/\//, "").replace(/^ar:\/\//, "");
  for (const gateway of gateways) {
    const base = gateway.replace(/\/+$/, "");
    // A directory CID returns an HTML index from a gateway; a file CID returns
    // the file itself. Try with a trailing slash first (directories), then
    // without (single files).
    for (const suffix of ["/", ""]) {
      const url = `${base}/${bare}${suffix}`;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
        if (!r.ok) {
          try {
            await r.body?.cancel();
          } catch {
            // Ignore.
          }
          continue;
        }
        const ct = r.headers.get("content-type") ?? "";
        // Read a bounded prefix rather than the whole body: a 10,000-entry
        // directory index is megabytes (BAYC's is 8.3MB / 15s from Pinata) and
        // the only thing needed from it is whether it IS an index and roughly
        // how many entries it holds.
        let text = "";
        const reader = r.body?.getReader();
        if (reader) {
          const dec = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done || !value) break;
              text += dec.decode(value, { stream: true });
              if (text.length >= MAX_INDEX_BYTES) break;
            }
          } finally {
            try {
              await reader.cancel();
            } catch {
              // Already closed.
            }
          }
        } else {
          text = await r.text();
        }
        const looksHtml = ct.includes("text/html") || /<a\s[^>]*href=/i.test(text);
        if (looksHtml) {
          const hrefs = [...text.matchAll(/href=["']?([^"'\s>]+)["']?/g)]
            .map((m) => m[1])
            .filter((h) => h && h !== "../" && h !== "/" && !h.startsWith("?") && !h.startsWith("#"));
          // Gateway index pages carry their own nav links (ipfs.tech, favicons,
          // the directory itself). A token directory is made of numeric or
          // .json entries, so prefer those and fall back to everything else.
          // Entries may be absolute paths ("/ipfs/<cid>/1"), so test the last
          // segment rather than the whole href.
          const tokenLike = hrefs.filter((h) => /^\d+(?:\.json)?$/i.test((h.split("/").pop() ?? "").split("?")[0]));
          const entries = tokenLike.length > 0 ? tokenLike : hrefs;
          return {
            cid,
            kind: "directory",
            fileCount: entries.length,
            sample: entries.slice(0, 5).map((h) => h.slice(0, 80)),
            note: `via ${gateway}${text.length >= MAX_INDEX_BYTES ? " (prefix only)" : ""}`,
            url,
          };
        }
        let note: string | undefined;
        try {
          const j = JSON.parse(text);
          note = `${typeof j?.name === "string" ? `json name="${j.name.slice(0, 60)}"` : "json"} via ${gateway}`;
        } catch {
          note = `${text.slice(0, 60)} via ${gateway}`;
        }
        return { cid, kind: "file", fileCount: 1, sample: [text.slice(0, 120)], note, url };
      } catch {
        // Try the next suffix / gateway.
      }
    }
  }
  return { cid, kind: "unfetchable", fileCount: 0, sample: [], note: "no gateway answered", url: null };
}

function extractCids(text: string | null): string[] {
  if (!text) return [];
  // One extractor for getters, events and bare CIDs. Paths are kept in the
  // normalised link but the CID itself is the directory key the resolver needs.
  return extractUris(text).map((link) =>
    link.replace(/^ipfs:\/\//, "").replace(/^ar:\/\//, "").split("/")[0]
  );
}

/** Ids that exist now, spread across the range; unminted low ids just revert. */
function sampleIdsFromSupply(total: bigint | null): number[] {
  if (total == null || total <= 0n) return [1, 2, 3, 4, 5];
  if (total <= 5n) {
    const out: number[] = [];
    for (let i = 1n; i <= total; i++) out.push(Number(i));
    return out;
  }
  const out = new Set<number>();
  for (let i = 0; i < 5; i++) {
    const id = 1n + ((total - 1n) * BigInt(i)) / 4n;
    out.add(Number(id));
  }
  return [...out];
}

export async function scanReveal(opts: RevealScanOptions): Promise<RevealScanResult> {
  const {
    rpcUrls,
    chainId,
    contract,
    sampleTokenIds,
    ipfsGateways = DEFAULT_GATEWAYS,
    logScanBlocks = 0,
    timeoutMs = 20_000,
    deep = true,
  } = opts;

  const res: RevealScanResult = {
    contract,
    chainId,
    verdict: "UNKNOWN",
    standard: opts.standard ?? "unknown",
    baseURI: null,
    revealedBySlash: null,
    contractURI: null,
    totalSupply: null,
    sampledTokenUris: [],
    distinctTokenUris: 0,
    inspections: [],
    logHits: [],
    deepPointers: null,
    findings: [],
    error: null,
  };

  if (!rpcUrls.length) {
    res.error = "no RPC endpoints";
    res.findings.push("No RPC endpoint was supplied, so nothing could be read.");
    return res;
  }

  // Walk the endpoints: a dead first URL must not make the scan report
  // "unknown" for a contract that is perfectly readable elsewhere.
  let provider: JsonRpcProvider | null = null;
  for (const url of rpcUrls) {
    try {
      const p = new JsonRpcProvider(url, chainId, { staticNetwork: true, pollingInterval: 4000 });
      await p.getBlockNumber();
      provider = p;
      break;
    } catch {
      // Next endpoint.
    }
  }
  if (!provider) {
    res.error = "no reachable RPC endpoint";
    res.findings.push("Every supplied RPC endpoint failed to answer eth_blockNumber.");
    return res;
  }

  try {
    // ── 1. baseURI / uri ────────────────────────────────────────────────────
    let base = await callString(provider, contract, "baseURI()");
    if (typeof base !== "string") base = null;
    if (base == null) {
      // ERC-1155 style: uri(id) with the {id} substitution. Try a real id.
      const u = await callString(provider, contract, "uri(uint256)", [1]);
      if (typeof u === "string") {
        base = u;
        res.standard = "erc1155";
      }
    } else {
      res.standard = "erc721";
    }
    res.baseURI = base;
    if (base != null) {
      res.revealedBySlash = base.endsWith("/");
    }

    // ── 2. contractURI ──────────────────────────────────────────────────────
    const curi = await callString(provider, contract, "contractURI()");
    res.contractURI = typeof curi === "string" ? curi : null;

    // ── 3. totalSupply (context for how much is minted) ─────────────────────
    const ts = await callBig(provider, contract, "totalSupply()");
    res.totalSupply = ts != null ? ts.toString() : null;

    // ── 4. per-token sample ────────────────────────────────────────────────
    const sig = res.standard === "erc1155" ? "uri(uint256)" : "tokenURI(uint256)";
    const sampledIds = sampleTokenIds?.length ? sampleTokenIds : sampleIdsFromSupply(ts);
    const seen = new Set<string>();
    for (const id of sampledIds) {
      let uri: string | null = null;
      let err: string | null = null;
      try {
        uri = await callString(provider, contract, sig, [id]);
        if (typeof uri !== "string") uri = null;
        if (uri != null) seen.add(uri);
      } catch (e: any) {
        err = e?.shortMessage ?? e?.message ?? String(e);
      }
      res.sampledTokenUris.push({ tokenId: id, uri, error: err });
    }
    res.distinctTokenUris = seen.size;

    // ── 4b. deep pointer discovery ────────────────────────────────────────
    let deepCids: string[] = [];
    if (deep) {
      const pointers = await collectDeepPointers({
        provider,
        chainId,
        contract,
        logScanBlocks,
        timeoutMs,
        etherscanKey: opts.etherscanKey,
      });
      res.deepPointers = pointers;
      deepCids = pointers.cids;
      for (const src of pointers.sources.slice(0, 12)) res.findings.push(`pointer: ${src}`);
      for (const err of pointers.errors) res.findings.push(`deep scan: ${err}`);
    }

    // ── 5. resolve every CID the contract publishes ────────────────────────
    const cids = new Set<string>([
      ...extractCids(res.baseURI),
      ...extractCids(res.contractURI),
      ...res.sampledTokenUris.flatMap((s) => extractCids(s.uri)),
      ...deepCids,
    ]);
    for (const cid of cids) {
      res.inspections.push(await inspectPublicCid(cid, ipfsGateways, timeoutMs));
    }

    // ── 6. bounded log sweep for metadata-like payloads ────────────────────
    if (logScanBlocks > 0) {
      try {
        const head = await provider.getBlockNumber();
        const from = Math.max(0, head - logScanBlocks);
        const logs = await provider.getLogs({ address: contract, fromBlock: from, toBlock: head });
        for (const log of logs) {
          const hay = `${log.data} ${log.topics.join(" ")}`;
          // ABI-encoded strings appear as hex; decode the printable runs and
          // look for the storage schemes a reveal would use.
          const printable = Buffer.from(hay.slice(2), "hex").toString("latin1");
          const hits = [...printable.matchAll(/(ipfs:\/\/[A-Za-z0-9]{20,}|ar:\/\/[A-Za-z0-9]{20,})/g)].map((m) => m[1]);
          if (hits.length > 0) {
            res.logHits.push({
              blockNumber: log.blockNumber,
              txHash: log.transactionHash,
              name: "Log",
              metadataLike: hits.slice(0, 4),
            });
          }
        }
      } catch {
        // A log sweep is best-effort; some endpoints refuse ranged getLogs.
      }
    }

    // ── verdict ────────────────────────────────────────────────────────────
    const directoryInspections = res.inspections.filter((i) => i.kind === "directory");
    const bigDirectory = directoryInspections.find((i) => i.fileCount >= Math.max(2, sampledIds.length));

    if (
      res.baseURI == null &&
      res.contractURI == null &&
      res.inspections.length === 0 &&
      !(res.deepPointers?.uris.length)
    ) {
      res.verdict = "UNKNOWN";
      res.findings.push(
        "No baseURI, contractURI or tokenURI could be read. The contract may be non-standard (an ERC-1155 needs a token id that already exists before uri(id) will answer), or every endpoint is refusing eth_call."
      );
    } else if (bigDirectory) {
      res.verdict = "PUBLIC";
      res.findings.push(
        `${bigDirectory.cid} resolves to a DIRECTORY of ${bigDirectory.fileCount} entries — the full id -> metadata mapping is published, whether or not the contract calls itself revealed.`
      );
    } else if (res.revealedBySlash === true) {
      res.verdict = "PUBLIC";
      res.findings.push(
        "baseURI ends with '/', so tokenURI(id) appends the token id: the drop is revealed and every token's metadata is readable."
      );
    } else if (res.distinctTokenUris > 1) {
      res.verdict = "PUBLIC";
      res.findings.push(
        `${res.distinctTokenUris} distinct tokenURI values across ${res.sampledTokenUris.length} sampled ids while baseURI is hidden — per-token metadata is already being served.`
      );
    } else if (res.logHits.length > 0) {
      res.verdict = "PARTIAL";
      res.findings.push(
        `The contract's logs reference metadata storage directly (${res.logHits
          .flatMap((h) => h.metadataLike)
          .slice(0, 3)
          .join(", ")}). Worth resolving by hand.`
      );
    } else if (res.baseURI != null || res.contractURI != null) {
      const single = res.inspections.every((i) => i.kind === "file" || i.kind === "unfetchable");
      if (res.revealedBySlash === false && single) {
        res.verdict = "HIDDEN";
        res.findings.push(
          "baseURI has no trailing slash and resolves to a single file: every token returns the same placeholder, so there is no per-token mapping to read."
        );
      } else {
        res.verdict = "PARTIAL";
        res.findings.push(
          "A metadata URI is published but it is a single file rather than a per-token directory; the mapping is not readable from it."
        );
      }
    } else if (res.deepPointers?.uris.length) {
      res.verdict = "PARTIAL";
      res.findings.push(
        `${res.deepPointers.uris.length} metadata pointer(s) were found in the ABI surface or events, but none resolved to a readable directory. Retry the CID with --gateway or inspect the links directly.`
      );
    } else {
      res.verdict = "UNKNOWN";
      res.findings.push("The contract answered, but nothing metadata-shaped was found.");
    }
  } catch (e: any) {
    res.error = e?.message ?? String(e);
    res.findings.push(`Scan failed: ${res.error}`);
  } finally {
    try {
      provider.destroy();
    } catch {
      // Already destroyed.
    }
  }

  return res;
}
