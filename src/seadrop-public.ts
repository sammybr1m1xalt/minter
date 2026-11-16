// Build SeaDrop public-mint calldata locally, with no OpenSea involvement.
//
// A public stage is unsigned: SeaDrop.mintPublic() takes only the drop's own
// parameters, so the whole transaction can be assembled from on-chain reads.
// That removes the access token, its expiry, OpenSea's rate limits, and — the
// part that actually matters for FCFS — the ~1s API round-trip from the
// critical path, because every tx can be signed before the stage even opens.
//
// The allowlist/FCFS stage is different in kind: mintSigned() carries a
// server-produced signature bound to one wallet, so that path still needs
// OpenSea and there is no local equivalent.

import { Contract, Interface, JsonRpcProvider } from "ethers";
import { withRpcTimeout, DEFAULT_READ_TIMEOUT_MS } from "./rpc-timeout";

export const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

// OpenSea's standard fee collector — the usual allowed recipient on their drops.
// Only used when a drop leaves the recipient list empty and unrestricted, since
// SeaDrop rejects the zero address outright. Exported so every module shares
// one literal: a copy silently edited would diverge from the others.
export const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";

const PUBLIC_ABI = [
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  // Mint mechanisms — these tell us whether a drop is signed or token-gated
  // rather than public, so a wallet that is not on the allowlist gets an
  // explanation instead of an on-chain revert.
  "function getSigners(address nftContract) view returns (address[])",
  "function getTokenGatedAllowedTokens(address nftContract) view returns (address[])",
];

const IFACE = new Interface(PUBLIC_ABI);

export interface PublicDrop {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

export interface LocalMintPlan {
  to: string; // always the SeaDrop singleton
  data: string; // identical for every wallet — see minterIfNotPayer below
  value: bigint; // mintPrice × quantity, exactly what SeaDrop expects
  drop: PublicDrop;
  feeRecipient: string;
}

/**
 * Read the public drop off an existing provider.
 *
 * Takes a provider rather than a URL so `buildLocalMintPlan` can read the drop
 * and its fee recipient over ONE connection. Two separate providers meant two
 * TCP/TLS setups and two sequential round trips for data that is always read
 * together.
 */
// Throws on a revert or an RPC failure. Those are different answers from "this
// contract has no public drop", and the blanket catch that used to be here
// collapsed all four (revert, unset mapping, dead endpoint, timeout) into one
// null — which is why a dead RPC read as "no drop". `null` now means only
// "the mapping is unset", the one case the caller cannot infer for itself.
async function readPublicDrop(
  provider: JsonRpcProvider,
  nftContract: string
): Promise<PublicDrop | null> {
  const seadrop = new Contract(SEADROP_ADDRESS, PUBLIC_ABI, provider);
  const raw = await seadrop.getPublicDrop(nftContract);
  const drop: PublicDrop = {
    mintPrice: BigInt(raw.mintPrice),
    startTime: Number(raw.startTime),
    endTime: Number(raw.endTime),
    maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
    feeBps: Number(raw.feeBps),
    restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
  };
  // An unset mapping entry decodes to all zeros rather than reverting.
  if (drop.startTime === 0 && drop.endTime === 0 && drop.maxTotalMintableByWallet === 0) {
    return null;
  }
  return drop;
}

// Returns null when this contract has no public drop on the SeaDrop singleton —
// either it isn't a SeaDrop collection at all, or it uses a newer variant that
// keeps drop config on the token contract itself.
export async function fetchPublicDrop(
  rpcUrl: string,
  nftContract: string,
  timeoutMs: number = DEFAULT_READ_TIMEOUT_MS
): Promise<PublicDrop | null> {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  try {
    return await withRpcTimeout(
      readPublicDrop(provider, nftContract),
      timeoutMs,
      "read the public drop"
    );
  } catch {
    // Convenience wrapper: null here means "no drop OR the read failed". Use
    // buildLocalMintPlanAttempt when the difference matters — it reports which.
    return null;
  } finally {
    destroyProvider(provider);
  }
}

// SeaDrop reverts on a zero fee recipient, and on a disallowed one when the drop
// restricts them — so this has to come from the chain, not a guess.
async function readFeeRecipient(
  provider: JsonRpcProvider,
  nftContract: string,
  restricted: boolean
): Promise<{ address: string; source: string } | null> {
  const seadrop = new Contract(SEADROP_ADDRESS, PUBLIC_ABI, provider);
  let allowed: string[] = [];
  try {
    allowed = await seadrop.getAllowedFeeRecipients(nftContract);
  } catch {
    allowed = [];
  }

  if (allowed.length > 0) {
    return { address: allowed[0], source: "allowed fee recipient on-chain" };
  }
  if (restricted) {
    // Nothing allowed and the drop enforces the list — a public mint cannot be
    // constructed at all, locally or otherwise.
    return null;
  }
  return { address: OPENSEA_FEE_RECIPIENT, source: "OpenSea default (drop does not restrict)" };
}

export async function resolveFeeRecipient(
  rpcUrl: string,
  nftContract: string,
  restricted: boolean,
  timeoutMs: number = DEFAULT_READ_TIMEOUT_MS
): Promise<{ address: string; source: string } | null> {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  try {
    return await withRpcTimeout(
      readFeeRecipient(provider, nftContract, restricted),
      timeoutMs,
      "read the fee recipient"
    );
  } finally {
    destroyProvider(provider);
  }
}

/** ethers keeps a polling timer alive on every provider; without an explicit
 *  destroy the process never exits. */
function destroyProvider(provider: JsonRpcProvider): void {
  try {
    provider.destroy();
  } catch {
    // Already destroyed.
  }
}

/**
 * Bound an RPC read.
 *
 * ethers v6 has no provider timeout, so a dead endpoint holds the promise (and
 * the wizard) open until the OS gives up on the socket — 5 s here, minutes on a
 * blackholed route. Every read through this module goes through this.
 *
 * The helper now lives in rpc-timeout.ts and is re-exported here so existing
 * imports keep working; new code should import it from there.
 */
export { withRpcTimeout, DEFAULT_READ_TIMEOUT_MS } from "./rpc-timeout";

export interface MintMechanisms {
  signers: string[];
  tokenGated: string[];
}

/**
 * Read which non-public mint mechanisms a drop uses.
 *
 * Used to explain WHY a public mint would fail: when a drop has signers or
 * token-gated tokens, a wallet that is not on the allowlist cannot mint publicly
 * at all, and the failure is better reported as a reason than discovered as an
 * on-chain revert.
 *
 * Both reads are best-effort: older SeaDrop variants do not expose these
 * getters, and a missing getter is not an error — it means "no such mechanism".
 */
export async function getMintMechanisms(
  rpcUrl: string,
  nftContract: string,
  timeoutMs: number = DEFAULT_READ_TIMEOUT_MS
): Promise<MintMechanisms> {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  try {
    return await withRpcTimeout(
      readMintMechanisms(provider, nftContract),
      timeoutMs,
      "read the mint mechanisms"
    );
  } catch {
    // Best-effort means best-effort: a provider failure is not evidence about
    // the drop, and throwing here would abort the wizard that asked the
    // question. The caller only uses this to explain a refusal.
    return { signers: [], tokenGated: [] };
  } finally {
    destroyProvider(provider);
  }
}

async function readMintMechanisms(
  provider: JsonRpcProvider,
  nftContract: string
): Promise<MintMechanisms> {
  const seadrop = new Contract(SEADROP_ADDRESS, PUBLIC_ABI, provider);
  let signers: string[] = [];
  let tokenGated: string[] = [];
  try {
    signers = Array.from(await seadrop.getSigners(nftContract) as string[]);
  } catch {
    /* not supported on this SeaDrop variant */
  }
  try {
    tokenGated = Array.from(
      await seadrop.getTokenGatedAllowedTokens(nftContract) as string[]
    );
  } catch {
    /* not supported on this SeaDrop variant */
  }
  return { signers, tokenGated };
}

// minterIfNotPayer = address(0) means "credit the caller", so the calldata is
// byte-identical for every wallet and can be encoded once and shared.
export function encodeMintPublic(
  nftContract: string,
  feeRecipient: string,
  quantity: number
): string {
  return IFACE.encodeFunctionData("mintPublic", [
    nftContract,
    feeRecipient,
    "0x0000000000000000000000000000000000000000",
    BigInt(quantity),
  ]);
}

/**
 * Build a public mint plan, reporting WHY when it cannot.
 *
 * `buildLocalMintPlan` returns null for every failure, which is what produced
 * "Could not build local mint plan for public phase" with no cause — a revert, an
 * unset drop, a dead endpoint and a timeout all read the same. This variant
 * carries the cause so the caller can say which one it hit.
 */
export async function buildLocalMintPlanAttempt(
  rpcUrl: string,
  nftContract: string,
  quantity: number,
  timeoutMs: number = DEFAULT_READ_TIMEOUT_MS
): Promise<{ plan: LocalMintPlan | null; reason: string }> {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  let drop: PublicDrop | null;
  let fee: { address: string; source: string } | null;
  const rpc = safeHost(rpcUrl);
  try {
    try {
      drop = await withRpcTimeout(
        readPublicDrop(provider, nftContract),
        timeoutMs,
        "read the public drop"
      );
    } catch (e: any) {
      return {
        plan: null,
        reason: `reading the public drop from ${rpc} failed: ${e?.shortMessage || e?.message || e}`,
      };
    }
    if (!drop) {
      return {
        plan: null,
        reason: `no public drop is set on the SeaDrop singleton for ${nftContract}`,
      };
    }
    try {
      fee = await withRpcTimeout(
        readFeeRecipient(provider, nftContract, drop.restrictFeeRecipients),
        timeoutMs,
        "read the fee recipient"
      );
    } catch (e: any) {
      return {
        plan: null,
        reason: `reading the fee recipient from ${rpc} failed: ${e?.shortMessage || e?.message || e}`,
      };
    }
    if (!fee) {
      return {
        plan: null,
        reason: `${nftContract} restricts fee recipients and none is allowed — no public mint can be built`,
      };
    }
  } finally {
    destroyProvider(provider);
  }

  return {
    plan: {
      to: SEADROP_ADDRESS,
      data: encodeMintPublic(nftContract, fee.address, quantity),
      value: drop.mintPrice * BigInt(quantity),
      drop,
      feeRecipient: fee.address,
    },
    reason: "",
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the endpoint";
  }
}

export async function buildLocalMintPlan(
  rpcUrl: string,
  nftContract: string,
  quantity: number,
  timeoutMs: number = DEFAULT_READ_TIMEOUT_MS
): Promise<LocalMintPlan | null> {
  return (await buildLocalMintPlanAttempt(rpcUrl, nftContract, quantity, timeoutMs)).plan;
}

/**
 * Build a local mint plan, trying each RPC in order until one answers.
 *
 * Every caller used to pass `rpcUrls[0]`, so one dead endpoint meant no plan —
 * and therefore no mint — on the very path whose purpose is redundancy: the
 * fire itself fans out across the whole set. The plan is built during the wait,
 * so trying them in order costs nothing but a few unmetered chain reads.
 */
export async function buildLocalMintPlanOnAnyRpc(
  rpcUrls: readonly string[],
  nftContract: string,
  quantity: number,
  timeoutMs: number = DEFAULT_READ_TIMEOUT_MS
): Promise<{ plan: LocalMintPlan | null; reason: string; rpcUrl: string | null }> {
  const urls = (rpcUrls || []).filter(Boolean);
  if (urls.length === 0) {
    return { plan: null, reason: "no RPC endpoint is configured for this chain", rpcUrl: null };
  }
  let last = "";
  for (const url of urls) {
    const attempt = await buildLocalMintPlanAttempt(url, nftContract, quantity, timeoutMs);
    if (attempt.plan) return { plan: attempt.plan, reason: "", rpcUrl: url };
    last = attempt.reason;
  }
  return { plan: null, reason: `every RPC endpoint failed — last: ${last}`, rpcUrl: null };
}
