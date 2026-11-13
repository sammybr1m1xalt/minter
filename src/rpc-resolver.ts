// Pick RPC endpoints for whichever chain the wizard selected.
//
// .env only holds one RPC_URL, which is fine when the chain is fixed there. The
// wizard lets you switch chains per run, so an unguarded RPC_URL would happily
// blast an Ethereum tx at a Base node. Resolution order per chain:
//
//   1. RPC_URL_<CHAIN>       — e.g. RPC_URL_BASE, RPC_URL_ETHEREUM (comma-separated ok)
//   2. RPC_URL + EXTRA_RPC_URLS — only when CHAIN in .env matches the selection
//   3. the public endpoints in src/chains.ts
//
// Chain confirmation happens inline: planRpcs() probes every endpoint for
// eth_chainId and drops any that report a different network.

import { resolveChain } from "./chains";

interface ResolvedRpcs {
  urls: string[];
  source: string; // human label describing where these came from
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

// Private endpoints already configured in .env for this chain, if any.
export function privateRpcsFromEnv(chainKey: string): string[] {
  const profile = resolveChain(chainKey);
  if (!profile) return [];

  // 1. Explicit per-chain entry always wins.
  const perChain = splitList(process.env[`RPC_URL_${chainKey.toUpperCase()}`]);
  if (perChain.length > 0) return perChain;

  const generic = [
    ...splitList(process.env.RPC_URL),
    ...splitList(process.env.EXTRA_RPC_URLS),
  ];
  if (generic.length === 0) return [];

  // A generic RPC_URL applies to whichever chain the user actually selected.
  //
  // It must NOT be gated on CHAIN matching: CHAIN is only a default for the
  // chain prompt, and the user's runtime choice (--chain, or the prompt answer)
  // is what matters. Gating on CHAIN meant selecting a different chain at
  // runtime silently discarded the user's only configured endpoint and fell
  // back to public RPCs — slow, rate-limited, and often wrong-chain.
  //
  // A generic endpoint is still verified against the selected chain by
  // planRpcs(), so a mismatched URL cannot produce a wrong-chain mint.
  return generic;
}

// `manual` (entered in the wizard) wins over anything in .env. Public endpoints
// always trail as fallbacks so there is something to blast at either way.
export function resolveRpcsForChain(chainKey: string, manual: string[] = []): ResolvedRpcs {
  const profile = resolveChain(chainKey);
  if (!profile) throw new Error(`Unknown chain "${chainKey}"`);

  if (manual.length > 0) {
    return {
      urls: dedupe([...manual, ...profile.rpc.public]),
      source: "entered above + public fallbacks",
    };
  }

  const fromEnv = privateRpcsFromEnv(chainKey);
  if (fromEnv.length > 0) {
    return {
      urls: dedupe([...fromEnv, ...profile.rpc.public]),
      source: ".env + public fallbacks",
    };
  }

  return {
    urls: dedupe(profile.rpc.public),
    source: "public endpoints only — too slow for a contested FCFS",
  };
}

// Accept either a full URL or a bare provider API key, which we expand against
// the chain's Alchemy host. Returns null if it's neither.
export function toRpcUrl(value: string, chainKey: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  if (raw.includes("://")) {
    try {
      new URL(raw);
      return raw;
    } catch {
      return null;
    }
  }

  // Bare key — only meaningful if we know where to point it.
  const host = resolveChain(chainKey)?.rpc.alchemyHost;
  if (!host) return null;
  if (!/^[A-Za-z0-9_-]{16,}$/.test(raw)) return null;
  return `https://${host}/v2/${raw}`;
}

// Hide the key segment so a shoulder-surf or screenshot doesn't leak it.
//
// This used to be a second, weaker implementation that (a) returned the input
// verbatim when it was not a parseable URL — printing a bare API key in full —
// and (b) revealed the first and last four characters of the key path segment.
// logger.ts holds the hardened version; re-export it so there is exactly one
// masker and every caller gets the safe behaviour.
export { maskRpc } from "./logger";

interface RpcPlan {
  urls: string[]; // blast list — index 0 is always query-capable when one exists
  verified: boolean; // at least one endpoint confirmed the expected chain id
  dropped: { url: string; chainId: number }[]; // removed: reported another chain
  sendOnly: string[]; // answered nothing, kept for blasting only
  failures: { url: string; message: string }[]; // answered with an error (bad key, quota)
}

// Probe result carrying *why* an endpoint failed, so an exhausted API key shows
// up during setup rather than as a rejected broadcast at fire time.

/**
 * True when a probe error means "this endpoint does not serve reads" rather than
 * "this endpoint is broken".
 *
 * A sequencer rejects eth_chainId with a JSON-RPC error ("method not found",
 * "not supported") but is the fastest inclusion path, so it must stay in the
 * blast set. An HTTP 500, a non-JSON body or a refused connection is evidence
 * the endpoint is broken and must not be blasted at.
 *
 * Shared with the wizard's endpoint report so the classification cannot drift
 * between what is displayed and what is used.
 */
export function isBenignProbeError(message: string | undefined): boolean {
  return /not allowed|does not exist|not supported|method not found|not enabled|unsupported/i.test(message ?? "");
}

/**
 * True when a probe failure means the request never reached the endpoint, or
 * the connection could not be established — as opposed to the endpoint
 * answering with an error.
 *
 * Undici wraps every socket-level failure in a generic `TypeError: fetch
 * failed` and puts the real code on `.cause` (`UND_ERR_CONNECT_TIMEOUT`,
 * `UND_ERR_SOCKET`, `ETIMEDOUT`, `ECONNREFUSED`, …). Only our own AbortSignal
 * produces an AbortError.
 *
 * This distinction is load-bearing: treating "fetch failed" as evidence the
 * endpoint is broken makes `planRpcs` DROP a working endpoint from the blast
 * set during a bad network minute — removing the only inclusion path, and
 * doing it silently.
 */
export function isTransportProbeError(
  message: string | null | undefined,
  causeCode?: string | null
): boolean {
  if (!message) return false;
  if (message === "timed out" || message === "fetch failed") return true;
  return /UND_ERR_|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH/i.test(
    `${message} ${causeCode ?? ""}`
  );
}

/**
 * Probe one endpoint. `unreachable` covers BOTH our own timeout and a
 * transport failure: in both cases the endpoint did not answer, so no verdict
 * about it is possible.
 */
async function probe(
  rpcUrl: string,
  timeoutMs = 8000
): Promise<{ chainId: number | null; error?: string; unreachable?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: { result?: string; error?: { message?: string } };
    try {
      json = JSON.parse(text);
    } catch {
      return { chainId: null, error: `HTTP ${res.status} (non-JSON response)` };
    }
    if (json.result) return { chainId: parseInt(json.result, 16) };
    if (json.error?.message) return { chainId: null, error: json.error.message };
    return { chainId: null, error: `HTTP ${res.status}` };
  } catch (err: unknown) {
    // Distinguish "we could not tell" from "the endpoint answered with an
    // error". Only the second is evidence the endpoint is broken.
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    const message = aborted ? "timed out" : err instanceof Error ? err.message : String(err);
    const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
    const unreachable = aborted || isTransportProbeError(message, causeCode);
    return { chainId: null, error: unreachable ? "unreachable" : message, unreachable };
  } finally {
    clearTimeout(timer);
  }
}

// Probe every endpoint and put a query-capable one first.
//
// This matters because the whole codebase treats rpcUrls[0] as "the provider"
// for nonces, balances, eth_call and receipts, while blasting to all of them.
// Some endpoints in the public list (Base's sequencer, for one) only accept
// eth_sendRawTransaction — perfect to blast at, useless to read from. Anything
// reporting a different chain is dropped outright rather than blasted at.
export async function planRpcs(urls: string[], expectedChainId: number): Promise<RpcPlan> {
  const probes = await Promise.all(
    urls.map(async (url) => ({ url, ...(await probe(url)) }))
  );

  const matching = probes.filter((p) => p.chainId === expectedChainId).map((p) => p.url);
  const dropped = probes
    .filter((p) => p.chainId !== null && p.chainId !== expectedChainId)
    .map((p) => ({ url: p.url, chainId: p.chainId as number }));
  const failures = probes
    .filter((p) => p.chainId === null && p.error)
    .map((p) => ({ url: p.url, message: p.error as string }));

  // "Send-only" must mean the endpoint cannot serve READS, not that it is
  // broken. A sequencer rejects eth_chainId with a JSON-RPC error but is the
  // fastest inclusion path, so it stays in the blast set; an HTTP 500 or a
  // non-JSON body is evidence of a broken endpoint and is dropped — blasting at
  // it adds a guaranteed-failing request per wallet, and when no endpoint
  // matches the chain it would become urls[0], the provider every read (nonce,
  // balance, eth_call) goes through. A timeout is neither: that is "we could
  // not tell", so it stays.
  const broken = new Set(
    probes
      .filter((p) => p.chainId === null && p.error && !p.unreachable && !isBenignProbeError(p.error))
      .map((p) => p.url)
  );
  const sendOnly = probes
    .filter((p) => p.chainId === null && !broken.has(p.url))
    .map((p) => p.url);

  return {
    urls: [...matching, ...sendOnly],
    verified: matching.length > 0,
    dropped,
    sendOnly,
    failures,
  };
}

