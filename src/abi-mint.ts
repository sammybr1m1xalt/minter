// ── ABI-driven mint discovery ───────────────────────────────────────────────
//
// The selector registry in mint-generic.ts is a fixed list of signatures.
// That caps coverage: Milady's real mint is `mintMiladys(uint256 numberOfTokens)`
// and appears in no registry. The ABI is the truth.
//
// This module fetches a contract's verified ABI and derives mint candidates
// from it, so coverage is bounded by what the contract actually exposes rather
// than by a hand-maintained list.
//
// Sources, in order:
//   1. Sourcify — open, no API key, covers most verified mainnet contracts.
//      https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=abi
//   2. Etherscan V2 — requires ETHERSCAN_API_KEY, covers chains Sourcify misses.
//      https://api.etherscan.io/v2/api?chainid={id}&module=contract&action=getabi
//
// Both are read-only public lookups. Nothing here signs or broadcasts.

import { Interface, JsonRpcProvider } from "ethers";

// ── ABI sources ─────────────────────────────────────────────────────────────

export interface AbiFetchResult {
  abi: any[] | null;
  source: "sourcify" | "etherscan" | null;
  error?: string;
}

/** Sourcify chain-path map. Only chains Sourcify serves need entries. */
/**
 * Fetch the verified ABI from Sourcify. Returns null when not verified.
 *
 * The chain id IS the path segment (`/server/v2/contract/{chainId}/{address}`),
 * so there is no chain map to maintain. A hardcoded identity map silently
 * excluded every chain added after it — arc (5042) was missing. Verified live:
 * an unknown chain returns HTTP 400 `unsupported_chain`, surfaced below.
 */
export async function fetchAbiFromSourcify(
  chainId: number,
  address: string,
  timeoutMs = 15_000
): Promise<AbiFetchResult> {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=abi`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as any;
      return { abi: null, source: null, error: `sourcify: ${body?.message ?? `HTTP ${res.status}`}` };
    }
    const json = (await res.json()) as any;
    if (!Array.isArray(json.abi) || json.abi.length === 0) {
      return { abi: null, source: null, error: "sourcify returned no abi" };
    }
    return { abi: json.abi, source: "sourcify" };
  } catch (e: any) {
    return { abi: null, source: null, error: `sourcify: ${e?.message ?? "fetch failed"}` };
  }
}

/** Fetch the verified ABI from Etherscan V2. Requires ETHERSCAN_API_KEY. */
export async function fetchAbiFromEtherscan(
  chainId: number,
  address: string,
  apiKey: string | undefined,
  timeoutMs = 15_000
): Promise<AbiFetchResult> {
  if (!apiKey) return { abi: null, source: null, error: "no ETHERSCAN_API_KEY" };

  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { abi: null, source: null, error: `etherscan HTTP ${res.status}` };
    const json = (await res.json()) as any;
    if (json.status !== "1") {
      return { abi: null, source: null, error: `etherscan: ${json.result ?? json.message}` };
    }
    const abi = JSON.parse(json.result);
    if (!Array.isArray(abi)) return { abi: null, source: null, error: "etherscan returned a non-array" };
    return { abi, source: "etherscan" };
  } catch (e: any) {
    return { abi: null, source: null, error: `etherscan: ${e?.message ?? "fetch failed"}` };
  }
}

/**
 * Fetch the ABI, trying Sourcify first then Etherscan.
 * Returns the first success; error reports the last failure.
 */
export async function fetchAbi(
  chainId: number,
  address: string,
  opts: { etherscanKey?: string; timeoutMs?: number } = {}
): Promise<AbiFetchResult> {
  const sourcify = await fetchAbiFromSourcify(chainId, address, opts.timeoutMs);
  if (sourcify.abi) return sourcify;

  if (opts.etherscanKey) {
    const etherscan = await fetchAbiFromEtherscan(chainId, address, opts.etherscanKey, opts.timeoutMs);
    if (etherscan.abi) return etherscan;
    return { abi: null, source: null, error: `sourcify: ${sourcify.error}; etherscan: ${etherscan.error}` };
  }

  return { abi: null, source: null, error: sourcify.error ?? "no abi source available" };
}

// ── Mint-function derivation ────────────────────────────────────────────────

/**
 * Heuristic: does this function look like a mint?
 *
 * Deliberately broad — the cost of a false positive is one extra eth_call, while
 * the cost of a false negative is a mint we never find. Excludes view/pure
 * functions (they cannot mint) and obvious non-mints.
 */
export function looksLikeMint(name: string, stateMutability: string): boolean {
  if (stateMutability === "view" || stateMutability === "pure") return false;
  if (!/mint|claim|purchase|buy|publicsale|presale|whitelist|allowlist/i.test(name)) return false;
  // Exclude setters and config — they are not user-facing mints.
  if (/^set|^configure|^flip|^toggle|^withdraw|^pause|^unpause|^renounce|^transfer|^approve/i.test(name)) {
    return false;
  }
  // Exclude owner-only helpers. These are real mints but not callable by us, and
  // probing them wastes calls and produces misleading "exists" results.
  if (/^reserve|^edit|^admin|^owner|^team|^founder|^dao|^airdrop/i.test(name)) return false;
  return true;
}

export interface AbiMintCandidate {
  name: string;
  signature: string;
  selector: string;
  inputs: { name: string; type: string; internalType?: string }[];
  stateMutability: string;
  payable: boolean;
}

/**
 * Derive mint candidates from an ABI.
 *
 * Each candidate carries its real parameter names and types, which is what makes
 * argument synthesis possible: `mintMiladys(uint256 numberOfTokens)` tells us the
 * parameter is a token count, whereas a bare `uint256` does not.
 */
export function deriveMintCandidates(abi: any[]): AbiMintCandidate[] {
  const iface = new Interface(abi as any);
  const out: AbiMintCandidate[] = [];

  for (const fragment of iface.fragments) {
    if (fragment.type !== "function") continue;
    const fn = fragment as any;
    if (!looksLikeMint(fn.name, fn.stateMutability)) continue;

    const inputs = (fn.inputs ?? []).map((i: any) => ({
      name: i.name ?? "",
      type: i.type,
      internalType: i.internalType,
    }));

    out.push({
      name: fn.name,
      signature: fn.format("sighash"),
      selector: fn.selector,
      inputs,
      stateMutability: fn.stateMutability,
      payable: fn.payable,
    });
  }

  // Most specific first: functions with fewer parameters are more likely to be
  // the simple public mint, and are cheaper to probe.
  return out.sort((a, b) => a.inputs.length - b.inputs.length);
}

// ── Argument synthesis from ABI ─────────────────────────────────────────────

export interface SynthContext {
  to: string;
  amount: bigint;
  /** Optional off-chain data, keyed by role. */
  proof?: string[];
  signature?: string;
  /** Token id, when the contract exposes one. */
  tokenId?: bigint;
}

export interface SynthResult {
  ok: boolean;
  args?: any[];
  reason?: string;
}

/**
 * Classify an ABI parameter by its name and type.
 *
 * This is the core of argument synthesis. Parameter NAMES are the signal:
 * `numberOfTokens` is a quantity, `to` is a recipient, `merkleProof` is a proof.
 * Types alone are ambiguous — `uint256` could be a quantity, a price, or an id.
 */
export type ParamRole =
  | "recipient"
  | "quantity"
  | "tokenId"
  | "proof"
  | "signature"
  | "data"
  | "unknown";

export function classifyParam(name: string, type: string): ParamRole {
  const n = name.toLowerCase().replace(/_/g, "");
  const t = type.toLowerCase();

  // Addresses: recipient unless the name says otherwise.
  if (t === "address") {
    if (/referr|fee|royalt|payable|payment|commission/i.test(n)) return "unknown";
    return "recipient";
  }

  // bytes32[] is almost always a merkle proof.
  if (t === "bytes32[]") return "proof";

  // bytes / bytes4 / string: signature or arbitrary data.
  if (t === "bytes" || t.startsWith("bytes")) {
    if (/sign|sig|signature/i.test(n)) return "signature";
    if (/proof|merkle/i.test(n)) return "proof";
    return "data";
  }
  if (t === "string") {
    if (/uri|tokenuri|metadata/i.test(n)) return "unknown";
    return "data";
  }

  // uint / int: quantity, token id, or something we cannot know.
  if (/^u?int/.test(t)) {
    if (/proof|merkle|index|stage|round|phase|nonce|salt/i.test(n)) return "unknown";
    if (/tokenid|token_id|tokenids/i.test(n)) return "tokenId";
    if (/referr|fee|price|cost|amountpaid|value/i.test(n)) return "unknown";
    if (/number|quantity|qty|count|amount|num|supply|limit|max/i.test(n)) return "quantity";
    // A bare uint256 with no informative name: assume quantity. This is the
    // common case for `mint(uint256)`, and the simulation gate catches errors.
    return "quantity";
  }

  return "unknown";
}

/**
 * A type-correct zero value for a parameter we cannot derive, or undefined when
 * the type has no safe zero. "0x" is only valid for dynamic `bytes`; for a
 * `bytes32` it throws at encode time and the probe then reports a real mint as
 * "selector absent", and for a `string` it encodes the literal text "0x".
 */
function zeroValueFor(type: string): string | undefined {
  if (type === "bytes") return "0x";
  if (type === "string") return "";
  if (/^bytes\d+$/.test(type)) return "0x" + "00".repeat(Number(type.slice(5)));
  return undefined;
}

/**
 * Build calldata arguments from an ABI candidate and a synthesis context.
 *
 * Returns { ok: false, reason } when a parameter cannot be filled safely — the
 * caller must SKIP rather than guess. This is the guard that prevents encoding a
 * fabricated proof, a wrong price, or a referral address.
 */
export function synthFromAbi(
  candidate: AbiMintCandidate,
  ctx: SynthContext
): SynthResult {
  const args: any[] = [];

  for (const input of candidate.inputs) {
    const role = classifyParam(input.name, input.type);

    switch (role) {
      case "recipient":
        if (!ctx.to || /^0x0+$/.test(ctx.to)) return { ok: false, reason: "no recipient address" };
        args.push(ctx.to);
        break;

      case "quantity":
        args.push(ctx.amount > 0n ? ctx.amount : 1n);
        break;

      case "tokenId":
        args.push(ctx.tokenId ?? 0n);
        break;

      case "proof":
        if (!ctx.proof || ctx.proof.length === 0) {
          return { ok: false, reason: `needs a merkle proof (${input.name})` };
        }
        args.push(ctx.proof);
        break;

      case "signature":
        if (!ctx.signature) {
          return { ok: false, reason: `needs a signature (${input.name})` };
        }
        args.push(ctx.signature);
        break;

      case "data": {
        const zero = zeroValueFor(input.type);
        if (zero === undefined) {
          return { ok: false, reason: `cannot synthesize a zero value for ${input.type} (${input.name})` };
        }
        args.push(zero);
        break;
      }

      case "unknown":
        // A parameter we cannot classify. Refuse rather than guess — a wrong
        // value here is a silent failure that costs gas to discover.
        return { ok: false, reason: `unclassifiable parameter ${input.name}:${input.type}` };
    }
  }

  return { ok: true, args };
}

// ── Probing ─────────────────────────────────────────────────────────────────

export interface ProbeResult {
  candidate: AbiMintCandidate;
  /** True when the call reverted WITH data — the selector exists. */
  exists: boolean;
  /** True when the call succeeded (would have minted, if broadcast). */
  wouldSucceed: boolean;
  error?: string;
  /**
   * True when the call reverted with NO data. That is ambiguous between
   * "selector absent" and "selector exists but reverted on state", so it must
   * not be reported as proof the selector is missing.
   */
  revertedWithoutData?: boolean;
}

/**
 * Probe an ABI-derived candidate against the chain.
 *
 * Distinguishes:
 *   - exists: false            → selector absent, skip
 *   - exists: true, wouldSucceed: false → present but reverting (needs payment,
 *     proof, allowlist, or the sale is closed)
 *   - exists: true, wouldSucceed: true  → the mint would go through
 */
export async function probeAbiCandidate(
  contract: string,
  provider: JsonRpcProvider,
  candidate: AbiMintCandidate,
  args: any[],
  from: string,
  value: bigint
): Promise<ProbeResult> {
  const iface = new Interface([`function ${candidate.signature}${candidate.payable ? " payable" : ""}`]);
  let data: string;
  try {
    data = iface.encodeFunctionData(candidate.name, args);
  } catch (e: any) {
    return { candidate, exists: false, wouldSucceed: false, error: `encode failed: ${e?.message}` };
  }

  try {
    await provider.call({ to: contract, from, data, value });
    return { candidate, exists: true, wouldSucceed: true };
  } catch (e: any) {
    const errData = e?.data ?? e?.info?.error?.data;
    if (errData && errData !== "0x") {
      return { candidate, exists: true, wouldSucceed: false, error: e?.reason ?? e?.shortMessage };
    }
    // No revert data: the selector may be absent OR the call may have reverted
    // on state (a bare require(false)). Flag the ambiguity rather than
    // declaring the selector missing.
    return {
      candidate,
      exists: false,
      wouldSucceed: false,
      error: e?.reason ?? e?.shortMessage ?? "reverted with no data",
      revertedWithoutData: true,
    };
  }
}

// ── Price reading from ABI ──────────────────────────────────────────────────

/**
 * Find a price by reading the contract's own price getter.
 *
 * Prefers getters whose name mentions mint/price/cost/sale. Returns null when
 * none exists — a free mint is a legitimate outcome, but the caller should
 * confirm via simulation rather than assume.
 */
export async function readPriceFromAbi(
  contract: string,
  provider: JsonRpcProvider,
  abi: any[],
  amount: bigint = 1n
): Promise<{ price: bigint; getter: string } | null> {
  const iface = new Interface(abi as any);
  const getters = iface.fragments.filter(
    (f) =>
      f.type === "function" &&
      ((f as any).stateMutability === "view" || (f as any).stateMutability === "pure")
  ) as any[];
  const viewGetters = getters.filter(
    (f) =>
      (f.inputs?.length ?? 0) <= 1 &&
      /^u?int/.test(f.outputs?.[0]?.type ?? "") &&
      /price|cost|fee|mint|sale/i.test(f.name)
  );

  // Prefer the most specific name.
  viewGetters.sort((a, b) => {
    const score = (n: string) =>
      /mintprice|^price$|publicsaleprice|^cost$|saleprice/.test(n.toLowerCase()) ? 0 : 1;
    return score(a.name) - score(b.name);
  });

  for (const g of viewGetters) {
    try {
      const args = g.inputs.length === 1 ? [amount] : [];
      const data = iface.encodeFunctionData(g.name, args);
      const raw = await provider.call({ to: contract, data });
      const decoded = iface.decodeFunctionResult(g.name, raw);
      const v = decoded[0];
      if (typeof v === "bigint") return { price: v, getter: g.name };
    } catch {
      continue;
    }
  }
  return null;
}
