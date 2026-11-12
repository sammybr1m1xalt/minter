// ── Contract verification ──────────────────────────────────────────────────
//
// The gate that makes the site-scanner safe. Given a candidate address (from
// any source — scraped HTML, a config file, user input), this module answers:
//
//   1. Is it a contract at all?          → eth_getCode
//   2. What ERC standard does it speak?   → ERC165 supportsInterface
//   3. If ERC165 is absent, what is it?   → fallback interface probes
//   4. Is it a platform we have an adapter for? → known-singleton check
//
// Nothing downstream should build calldata for an address that has not passed
// through here. That is the whole point: a scraped address is untrusted input,
// and the difference between "not a contract" and "a contract we do not
// understand" is the difference between a clean refusal and a burned gas fee.
//
// All functions are read-only (eth_call / eth_getCode). Nothing here signs or
// broadcasts anything.

import { JsonRpcProvider } from "ethers";
import { resolveChain } from "./chains";
import { SEADROP_ADDRESS } from "./seadrop-public";

// ── ERC165 interface IDs ────────────────────────────────────────────────────
// ERC165 works by asking a contract "do you support interface X?" — the answer
// is derived from the interface's function selectors, so these IDs are stable
// and canonical. Verified against the ERC165 spec and OpenZeppelin's
// SupportsInterfaceWithLookup.

export const ERC165 = "0x01ffc9a7";
export const ERC721 = "0x80ac58cd";
export const ERC721_ENUMERABLE = "0x780e9d63";
export const ERC721_METADATA = "0x5b5e139f";
export const ERC1155 = "0xd9b67a26";
export const ERC1155_METADATA_URI = "0x0e89341c";

// ── Known platform singletons ───────────────────────────────────────────────
// These are the addresses a specific adapter can handle. Checking them is
// cheaper and more certain than probing for behaviour.

// SeaDrop has exactly one shared singleton (v1); v2 has no singleton address —
// see mint-generic.ts. The address lives in seadrop-public.ts and is imported
// rather than copied; a second literal here would drift from the one the mint
// path actually targets.
export const SEADROP_V1 = SEADROP_ADDRESS;
export const SEADROP_V2 = SEADROP_V1;

// ── Types ───────────────────────────────────────────────────────────────────

export type ErcStandard = "erc721" | "erc1155" | "unknown";

export type Platform = "seadrop-v1" | "none";

export interface VerificationResult {
  address: string;
  chainId: number;
  /** False when eth_getCode returned empty — an EOA or a non-contract. */
  isContract: boolean;
  standard: ErcStandard;
  /** True when ERC165 answered; false when we fell back to probing. */
  erc165Supported: boolean;
  platform: Platform;
  /** Human-readable reason, always populated when isContract is false. */
  reason?: string;
}

// ── Provider helper ─────────────────────────────────────────────────────────

/**
 * Run a read against the chain's RPCs, trying each in turn.
 *
 * Public RPCs rate-limit bursts and occasionally drop a request entirely. A
 * single failed call would otherwise surface as "not a contract" — a false
 * negative that silently discards a real candidate. Trying every configured
 * endpoint costs nothing when the first works and turns a transient failure
 * into a successful read.
 */
async function withProviderFailover<T>(
  chainId: number,
  fn: (provider: JsonRpcProvider) => Promise<T>,
  timeoutMs = 20_000
): Promise<T> {
  const profile = resolveChain(chainId);
  const urls = profile?.rpc?.public ?? [];
  if (urls.length === 0) {
    throw new Error(`No public RPC configured for chainId ${chainId}`);
  }

  // ethers' FetchRequest default is 300s per call, so a failover loop over
  // several endpoints had no ceiling at all. One deadline for the whole
  // failover, spent per endpoint.
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (const url of urls) {
    const remaining = deadline - Date.now();
    if (remaining < 200) throw lastErr ?? new Error("contract verification timed out");
    const provider = new JsonRpcProvider(url, undefined, {
      staticNetwork: true,
      pollingInterval: 2000,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(provider),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("RPC timeout")), remaining);
        }),
      ]);
    } catch (err) {
      lastErr = err;
    } finally {
      if (timer) clearTimeout(timer);
      // ethers keeps a polling timer alive on every provider. Without an
      // explicit destroy the process never exits.
      try {
        provider.destroy();
      } catch {
        // Already destroyed.
      }
    }
  }
  throw lastErr;
}

// ── Step 1: is it a contract? ───────────────────────────────────────────────

/**
 * eth_getCode returns the contract's bytecode. An EOA returns "0x".
 * This single call is what separates "scraped a token address" from
 * "found the NFT contract".
 *
 * ⚠ EIP-7702 caveat (verified 2026-11-06): a delegated EOA has bytecode of the
 * form 0xef0100 + 20-byte address. eth_getCode therefore returns non-empty for
 * an EOA that has delegated its execution. Callers that need certainty should
 * treat a 0xef0100-prefixed result as "not a contract" — see isDelegatedEoa.
 */
export async function getCode(
  address: string,
  chainId: number
): Promise<string> {
  return withProviderFailover(chainId, (provider) => provider.getCode(address));
}

/** True when the bytecode is an EIP-7702 delegation designator. */
export function isDelegatedEoaCode(code: string): boolean {
  return code.toLowerCase().startsWith("0xef0100");
}

export async function isContract(
  address: string,
  chainId: number
): Promise<boolean> {
  try {
    const code = await getCode(address, chainId);
    if (code === "0x" || code.length <= 2) return false;
    // A delegated EOA is not a contract we can mint from.
    if (isDelegatedEoaCode(code)) return false;
    return true;
  } catch {
    return false;
  }
}

// ── Step 2: ERC165 ──────────────────────────────────────────────────────────

const ERC165_ABI = [
  "function supportsInterface(bytes4 interfaceID) view returns (bool)",
];

async function supportsInterface(
  provider: JsonRpcProvider,
  address: string,
  interfaceId: string
): Promise<boolean | null> {
  try {
    const result = await provider.call({
      to: address,
      data: "0x01ffc9a7" + interfaceId.slice(2),
    });
    // ABI-encoded bool: 32 bytes, 0...01 for true, 0...00 for false.
    return result === "0x" + "0".repeat(63) + "1";
  } catch {
    // A revert means the contract does not implement ERC165 at all.
    return null;
  }
}

// ── Step 3: fallback probes (no ERC165) ─────────────────────────────────────

const FALLBACK_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

/**
 * Many older ERC721/ERC1155 contracts predate ERC165 or simply do not implement
 * it. Probe for the distinguishing functions instead.
 *
 * The key distinction: ERC1155's balanceOf takes (address,uint256); ERC721's
 * takes (address). A contract that answers the two-arg form is ERC1155.
 */
export async function detectStandardFallback(
  provider: JsonRpcProvider,
  address: string
): Promise<{ standard: ErcStandard; erc165Supported: false }> {
  const addr32 = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  // Probe more than one argument. A contract that reverts on the zero address,
  // or on tokenId 0/1, would otherwise be misreported as "unknown" — a false
  // negative that silently discards a real candidate.
  const probeAddrs = [addr32, "0".repeat(63) + "1"];
  const probeIds = ["0".repeat(64), "0".repeat(63) + "1"];

  // ERC1155: balanceOf(address,uint256) — selector 0x00fdd58e
  // A contract that answers this is ERC1155; ERC721 has no such function.
  for (const a of probeAddrs) {
    for (const id of probeIds) {
      try {
        await provider.call({ to: address, data: "0x00fdd58e" + a + id });
        return { standard: "erc1155", erc165Supported: false };
      } catch {
        // try the next argument
      }
    }
  }

  // ERC721: balanceOf(address) — selector 0x70a08231
  // This is the most reliable ERC721 signal short of ERC165.
  for (const a of probeAddrs) {
    try {
      await provider.call({ to: address, data: "0x70a08231" + a });
      return { standard: "erc721", erc165Supported: false };
    } catch {
      // try the next address
    }
  }

  // ERC721: ownerOf(uint256) — selector 0x6352211e
  for (const id of probeIds) {
    try {
      await provider.call({ to: address, data: "0x6352211e" + id });
      return { standard: "erc721", erc165Supported: false };
    } catch {
      // try the next id
    }
  }

  // Last resort: name() exists on both standards but not on a plain wallet.
  // Either way the standard is indeterminate — the call only distinguishes
  // "some contract" from "nothing", and both branches reported the same thing.
  try {
    await provider.call({ to: address, data: "0x06fdde03" }); // name()
  } catch {
    // No name() either — still a contract, still unknown.
  }
  return { standard: "unknown", erc165Supported: false };
}

// ── Step 4: full verification ───────────────────────────────────────────────

/**
 * Verify a candidate address on a specific chain.
 *
 * Order matters: getCode first (cheapest, eliminates the most candidates),
 * then ERC165, then fallback probes.
 */
export async function verifyContract(
  address: string,
  chainId: number
): Promise<VerificationResult> {
  try {
    return await withProviderFailover(chainId, (provider) =>
      verifyContractInner(address, chainId, provider)
    );
  } catch (err: any) {
    // Every RPC failed. Report it as an RPC error rather than "not a contract" —
    // a network failure is not evidence about the address.
    return {
      address,
      chainId,
      isContract: false,
      standard: "unknown",
      erc165Supported: false,
      platform: "none",
      reason: `RPC error: ${err?.shortMessage ?? err?.message ?? "all endpoints failed"}`,
    };
  }
}

async function verifyContractInner(
  address: string,
  chainId: number,
  provider: JsonRpcProvider
): Promise<VerificationResult> {
  // 1. Contract?
  let code: string;
  try {
    code = await provider.getCode(address);
  } catch (err: any) {
    return {
      address,
      chainId,
      isContract: false,
      standard: "unknown",
      erc165Supported: false,
      platform: "none",
      reason: `RPC error reading code: ${err?.shortMessage ?? err?.message ?? "unknown"}`,
    };
  }

  if (code === "0x" || code.length <= 2) {
    return {
      address,
      chainId,
      isContract: false,
      standard: "unknown",
      erc165Supported: false,
      platform: "none",
      reason: "not a contract (eth_getCode returned empty — EOA or non-contract)",
    };
  }

  // EIP-7702: a delegated EOA carries bytecode (0xef0100 + address) but is not
  // a contract. Verified live: vitalik.eth returns exactly that pattern.
  if (isDelegatedEoaCode(code)) {
    return {
      address,
      chainId,
      isContract: false,
      standard: "unknown",
      erc165Supported: false,
      platform: "none",
      reason: "EIP-7702 delegated EOA — has bytecode but is not a contract",
    };
  }

  // 2. Known singleton? Cheapest and most certain identification.
  const lower = address.toLowerCase();
  if (lower === SEADROP_V1 || lower === SEADROP_V2) {
    return { address, chainId, isContract: true, standard: "unknown", erc165Supported: false, platform: "seadrop-v1" };
  }

  // 3. ERC165
  const isErc721 = await supportsInterface(provider, address, ERC721);
  const isErc1155 = await supportsInterface(provider, address, ERC1155);

  if (isErc721 === true) {
    return { address, chainId, isContract: true, standard: "erc721", erc165Supported: true, platform: "none" };
  }
  if (isErc1155 === true) {
    return { address, chainId, isContract: true, standard: "erc1155", erc165Supported: true, platform: "none" };
  }

  // 4. Fallback probes
  const fb = await detectStandardFallback(provider, address);
  return {
    address,
    chainId,
    isContract: true,
    standard: fb.standard,
    erc165Supported: false,
    platform: "none",
    reason: fb.standard === "unknown" ? "contract detected but standard could not be determined" : undefined,
  };
}

