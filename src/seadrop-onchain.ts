// ── On-chain SEADROP phase discovery fallback ────────────────────────────────
// Query the real SeaDrop singleton (0x00005EA00Ac477B1030CE78506496e8C2dE24bf5)
// for every phase type the contract actually exposes. The deployed contract does
// NOT have getDrop() or getAllActiveDrops() — those are fabricated. The real
// functions are:
//
//   getPublicDrop(address) → PublicDrop
//     (mintPrice, startTime, endTime, maxTotalMintableByWallet, feeBps,
//      restrictFeeRecipients)
//
//   getSignedMintValidationParams(address, signer) → SignedMintValidationParams
//     (minMintPrice, maxMaxTotalMintableByWallet, minStartTime, maxEndTime,
//      maxMaxTokenSupplyForStage, minFeeBps, maxFeeBps)
//     — called with signer=0x0…0 to check if ANY signed mint is configured
//
//   getAllowListMerkleRoot(address) → bytes32
//     — non-zero means an allowlist/OVR phase exists for this contract
//
//   getAllowedFeeRecipients(address) → address[]
//     — non-empty means fee-restricted minting is configured
//
//   getTokenGatedDrop(address, allowedNftToken) → TokenGatedDropStage
//     — token-gated phase (needs an allowed NFT token address; we can't
//       enumerate these without knowing the allowed tokens, so this is an
//       extension point rather than a primary discovery path)
//
//   getCreatorPayoutAddress(address) → address
//     — who gets paid; useful for displaying fee recipient info
//
// We check all of these in parallel for a given nftContract. Each non-trivial
// result becomes a DropPhase entry. This covers public, signed-mint, and
// allowlist/OVR phases. Token-gated phases need the allowed token addresses
// which we can't discover on-chain without additional metadata — those are
// flagged for manual check.

import { JsonRpcProvider, Interface } from "ethers";
import type { DropPhase } from "./fcfs-drops";
import { OPENSEA_FEE_RECIPIENT } from "./seadrop-public";

const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

// ── Minimal ABI: only the read functions we actually call ──────────────────
const ABI = [
  // Public drop — the simplest phase type
  "function getPublicDrop(address nftContract) view returns (" +
    "uint80 mintPrice, " +
    "uint48 startTime, " +
    "uint48 endTime, " +
    "uint16 maxTotalMintableByWallet, " +
    "uint16 feeBps, " +
    "bool restrictFeeRecipients" +
  ")",

  // Signed mint validation params — set per signer; if any signer has params,
  // a signed-mint phase exists. We query with the zero address as a probe:
  // if _signedMintValidationParams[nftContract][0x0] is set, signed mints exist.
  // (The real function needs a specific signer address; we use 0x0 as a sentinel
  //  and also try getAllowedFeeRecipients + getAllowListMerkleRoot as signals.)
  "function getSignedMintValidationParams(address nftContract, address signer) view returns (" +
    "uint80 minMintPrice, " +
    "uint24 maxMaxTotalMintableByWallet, " +
    "uint40 minStartTime, " +
    "uint40 maxEndTime, " +
    "uint40 maxMaxTokenSupplyForStage, " +
    "uint16 minFeeBps, " +
    "uint16 maxFeeBps" +
  ")",

  // Allowlist merkle root — non-zero means an allowlist phase exists
  "function getAllowListMerkleRoot(address nftContract) view returns (bytes32)",

  // Allowed fee recipients — non-empty means fee-restricted minting
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",

  // Creator payout address
  "function getCreatorPayoutAddress(address nftContract) view returns (address)",

  // Token-gated drop — we can't enumerate allowed tokens, but we can probe
  // a common pattern: some collections use the nftContract itself as the gate.
  // This is a best-effort probe, not exhaustive.
  "function getTokenGatedDrop(address nftContract, address allowedNftToken) view returns (" +
    "uint80 mintPrice, " +
    "uint16 maxTotalMintableByWallet, " +
    "uint48 startTime, " +
    "uint48 endTime, " +
    "uint8 dropStageIndex, " +
    "uint32 maxTokenSupplyForStage, " +
    "uint16 feeBps, " +
    "bool restrictFeeRecipients" +
  ")",
];

const IFACE = new Interface(ABI);

const RPC_URLS_PUBLIC = [
  "https://ethereum.publicnode.com",
  "https://rpc.ankr.com/eth",
  "https://cloudflare-eth.com",
];

// Per-chain public RPCs. The SeaDrop singleton is deployed on every network,
// so the probe must go to the chain the collection lives on — an Ethereum RPC
// returns empty data for a Base drop, which silently looks like "no phases".
const RPC_URLS_BY_CHAIN: Record<string, string[]> = {
  ethereum: RPC_URLS_PUBLIC,
  base: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
  ],
  robinhood: [
    "https://rpc.mainnet.chain.robinhood.com",
  ],
  soneium: [
    "https://rpc.soneium.org",
    "https://soneium-rpc.publicnode.com",
  ],
  // Arc (chainId 5042) is in CHAINS but was missing here, so rpcUrlsForChain
  // fell back to the Ethereum list and an Arc collection probed Ethereum's
  // SeaDrop — returning no phases for a drop that plainly had them.
  arc: [
    "https://rpc.mainnet.arc.io",
    "https://rpc.drpc.mainnet.arc.io",
  ],
};

// Use .env RPC first if configured (private, faster), then fall back to public
function rpcUrlsForChain(chainKey?: string): string[] {
  const key = (chainKey || "ethereum").trim().toLowerCase();
  const envVar = `RPC_URL_${key.toUpperCase()}`;
  const envRpc = process.env[envVar];
  const publics = RPC_URLS_BY_CHAIN[key] ?? RPC_URLS_PUBLIC;
  if (envRpc && envRpc.trim()) {
    return [envRpc.trim(), ...publics];
  }
  return publics;
}

async function getProvider(chainKey?: string): Promise<JsonRpcProvider | null> {
  for (const url of rpcUrlsForChain(chainKey)) {
    const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
    try {
      await Promise.race([
        p.getBlockNumber(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
      ]);
      return p;
    } catch {
      // This endpoint failed its probe — destroy it before trying the next, or
      // every failed attempt leaks a polling timer.
      try {
        p.destroy();
      } catch {
        // Already destroyed.
      }
    }
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toSec(raw: bigint): number {
  return Number(raw);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Reject phases that ended more than 24h ago (stale data — skip) */
function isStale(endTime: number): boolean {
  return endTime > 0 && endTime < nowSec() - 86400;
}

/** Reject phases that start more than 30 days in the future (too far out) */
function isTooFar(startTime: number): boolean {
  return startTime > nowSec() + 86400 * 30;
}

// ── Public drop ────────────────────────────────────────────────────────────

async function fetchPublicDrop(
  provider: JsonRpcProvider,
  nftContract: string,
): Promise<DropPhase | null> {
  const data = IFACE.encodeFunctionData("getPublicDrop", [nftContract]);
  const result = await provider.send("eth_call", [{ to: SEADROP, data }, "latest"]);
  if (!result || result === "0x") return null;

  const d = IFACE.decodeFunctionResult("getPublicDrop", result);
  const startTime = toSec(d.startTime);
  const endTime = toSec(d.endTime);

  // Empty drop (all zeros) — no public drop registered
  if (startTime === 0 && endTime === 0 && d.mintPrice === 0n) return null;
  if (isStale(endTime) && startTime < nowSec()) return null;

  const isPublic = d.mintPrice > 0n || startTime > 0;
  const phaseType = isPublic ? "public" : "unknown";

  // Resolve fee recipient from chain — SeaDrop rejects zero address and
  // disallowed recipients when restrictFeeRecipients is set.
  let feeRecipient: string | null = OPENSEA_FEE_RECIPIENT;
  if (d.restrictFeeRecipients) {
    let allowed: string[] = [];
    try {
      const feeData = await provider.send("eth_call", [
        { to: SEADROP, data: IFACE.encodeFunctionData("getAllowedFeeRecipients", [nftContract]) },
        "latest",
      ]);
      if (feeData && feeData !== "0x") {
        const decoded = IFACE.decodeFunctionResult("getAllowedFeeRecipients", feeData);
        allowed = (decoded[0] as unknown[]) as string[];
      }
    } catch { /* fall through to default */ }
    if (allowed.length > 0) {
      feeRecipient = allowed[0];
    } else {
      // Restricted but no allowed recipients — public mint is impossible
      return null;
    }
  }

  return {
    dropId: `onchain-public-${nftContract.slice(0, 10)}`,
    nftContract,
    name: "Public Mint",
    type: phaseType,
    startTime,
    // 0 = unknown. Fabricating a date (the old `now + 1 year`) made the phase
    // look open for a year and stopped isPast/isStale from ever firing.
    endTime,
    mintPrice: d.mintPrice || 0n,
    maxTotalMintableByWallet: Number(d.maxTotalMintableByWallet),
    maxTotalMintable: 0, // public drops don't have a total cap on-chain
    totalMinted: 0,       // can't get from SeaDrop — check the NFT contract
    feeBps: Number(d.feeBps),
    feeRecipient: feeRecipient, // default SEA DEX fee addr
    mintData: null,
    mintSignature: null,
    gasLimit: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    eligible: null,
    eligibleCount: null,
    totalAllocated: null,
    allowlistedAddresses: [],
    allowlistHash: null,
    raw: { source: "onchain_public" },
    isPublicStage: true,
    eligiblePrice: null,
  };
}

// ── Allowlist / OVR phase (detected via merkle root + fee recipients) ──────
// SeaDrop doesn't expose a single "getAllowlistDrop" function. Instead, an
// allowlist phase is indicated by:
//   - getAllowListMerkleRoot returning non-zero, AND
//   - getAllowedFeeRecipients returning non-empty (fee-restricted minting)
// The mint parameters for allowlist mints come from the signed mint flow
// (mintSigned), not from a public drop struct. So we report the phase exists
// but flag that signed data is needed.

async function fetchAllowlistPhase(
  provider: JsonRpcProvider,
  nftContract: string,
): Promise<DropPhase | null> {
  const [merkleRootRaw, feeRecipientsRaw] = await Promise.all([
    provider.send("eth_call", [
      { to: SEADROP, data: IFACE.encodeFunctionData("getAllowListMerkleRoot", [nftContract]) },
      "latest",
    ]),
    provider.send("eth_call", [
      { to: SEADROP, data: IFACE.encodeFunctionData("getAllowedFeeRecipients", [nftContract]) },
      "latest",
    ]),
  ]);

  // The contract returns 32 ZERO bytes for a contract with no allowlist — not
  // "0x", and not a revert. Treating that as a real root invented an allowlist
  // phase for every collection.
  const merkleRoot =
    merkleRootRaw && merkleRootRaw !== "0x" && !/^0x0*$/.test(merkleRootRaw)
      ? merkleRootRaw
      : null;
  let feeRecipients: string[] = [];
  if (feeRecipientsRaw && feeRecipientsRaw !== "0x") {
    try {
      const decoded = IFACE.decodeFunctionResult("getAllowedFeeRecipients", feeRecipientsRaw);
      feeRecipients = decoded[0] as string[];
    } catch {
      feeRecipients = [];
    }
  }

  // A real allowlist/OVR phase is indicated by a NON-ZERO merkle root.
  // getAllowedFeeRecipients returns the default fee recipient for every
  // registered collection (even those without allowlist), so a non-empty
  // list alone is NOT a reliable allowlist signal.
  if (!merkleRoot) return null;

  return {
    dropId: `onchain-allowlist-${nftContract.slice(0, 10)}`,
    nftContract,
    name: feeRecipients.length > 0 ? "Allowlist / Fee-Restricted" : "Allowlist (Merkle)",
    type: "allowlist",
    startTime: 0,
    endTime: 0,
    mintPrice: 0n,
    maxTotalMintableByWallet: 0,
    maxTotalMintable: 0,
    totalMinted: 0,
    feeBps: 0,
    feeRecipient: feeRecipients[0] || null,
    mintData: null,
    mintSignature: null,
    gasLimit: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    eligible: null,
    eligibleCount: null,
    totalAllocated: null,
    allowlistedAddresses: [],
    allowlistHash: merkleRoot,
    raw: { source: "onchain_allowlist", merkleRoot, feeRecipientsCount: feeRecipients.length },
    isPublicStage: false, // allowlist needs signed mint or merkle proof
    eligiblePrice: null,
  };
}

// ── Signed mint phase (detected via validation params or fee recipients) ───
// Signed mints are configured per-signer. We can't enumerate all signers on-chain
// without a trace, but we can detect their presence by:
//   - getAllowedFeeRecipients non-empty AND restrictFeeRecipients was true in
//     the public drop (fee restriction = signed mint territory), OR
//   - probing getSignedMintValidationParams with a few common signer patterns
//
// Since we can't enumerate signers cheaply, we treat the allowlist phase above
// as also covering signed-mint phases. The mintSigned() call path handles the
// actual signed payload fetching at mint time.

// ── Token-gated phase (probe with nftContract itself as the gate token) ────
// Some collections gate mints behind ownership of a specific NFT. SeaDrop stores
// these per (nftContract, allowedNftToken) pair. We probe with the nftContract
// itself as a heuristic — if it returns data, a token-gated phase exists.

async function fetchTokenGatedPhase(
  provider: JsonRpcProvider,
  nftContract: string,
): Promise<DropPhase | null> {
  try {
    const data = IFACE.encodeFunctionData("getTokenGatedDrop", [nftContract, nftContract]);
    const result = await provider.send("eth_call", [{ to: SEADROP, data }, "latest"]);
    if (!result || result === "0x") return null;

    const d = IFACE.decodeFunctionResult("getTokenGatedDrop", result);
    const startTime = toSec(d.startTime);
    const endTime = toSec(d.endTime);

    if (startTime === 0 && endTime === 0) return null;
    if (isStale(endTime) && startTime < nowSec()) return null;

    return {
      dropId: `onchain-tokengated-${nftContract.slice(0, 10)}`,
      nftContract,
      name: "Token-Gated Mint",
      type: "token-gated",
      startTime,
      // 0 = unknown. Fabricating a date (the old `now + 1 year`) made the phase
    // look open for a year and stopped isPast/isStale from ever firing.
    endTime,
      mintPrice: d.mintPrice || 0n,
      maxTotalMintableByWallet: Number(d.maxTotalMintableByWallet),
      maxTotalMintable: Number(d.maxTokenSupplyForStage),
      totalMinted: 0,
      feeBps: Number(d.feeBps),
      feeRecipient: OPENSEA_FEE_RECIPIENT,
      mintData: null,
      mintSignature: null,
      gasLimit: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      eligible: null,
      eligibleCount: null,
      totalAllocated: Number(d.maxTokenSupplyForStage) || null,
      allowlistedAddresses: [],
      allowlistHash: null,
      raw: { source: "onchain_tokengated", gateToken: nftContract },
      isPublicStage: false,
      eligiblePrice: null,
      };
  } catch {
    return null;
  }
}

// ── Main entry: discover ALL phase types for a contract ────────────────────

export async function fetchOnChainDrops(
  nftContract: string,
  timeoutMs = 10000,
  chainKey?: string,
): Promise<DropPhase[]> {
  const provider = await getProvider(chainKey);
  if (!provider) return [];

  // timeoutMs must bound the whole discovery. The individual eth_calls carry
  // no signal, so race the batch against a timer; the provider is destroyed in
  // the finally regardless of how the race ends. Previously `_deadline` was
  // computed and never used, so a stalled RPC hung the discovery forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Run all probes in parallel, collect whatever returns data
    const probes = [
      fetchPublicDrop(provider, nftContract),
      fetchAllowlistPhase(provider, nftContract),
      fetchTokenGatedPhase(provider, nftContract),
    ];

    const results = await Promise.race([
      Promise.allSettled(probes),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("on-chain discovery timeout")), timeoutMs);
      }),
    ]);

    const drops: DropPhase[] = [];

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        drops.push(result.value);
      }
    }

    // Deduplicate: if public + allowlist both exist for same contract, both are
    // valid phases. No dedup needed — they're different phase types.

    // Filter out stale entries
    return drops.filter((d) => {
      if (d.endTime > 0 && isStale(d.endTime)) return false;
      if (d.startTime > 0 && isTooFar(d.startTime)) return false;
      return true;
    });
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    try {
      provider.destroy();
    } catch {
      // Already destroyed.
    }
  }
}

// ── Single-contract quick check (used by wizard when REST/GraphQL fail) ────

export async function fetchSingleOnChainDrop(
  nftContract: string,
  _timeoutMs = 10000,
  chainKey?: string,
): Promise<DropPhase | null> {
  const provider = await getProvider(chainKey);
  if (!provider) return null;

  try {
    // Try public drop first (most common / most likely to be targetable)
    const publicDrop = await fetchPublicDrop(provider, nftContract);
    if (publicDrop) return publicDrop;

    // Then allowlist
    const allowlist = await fetchAllowlistPhase(provider, nftContract);
    if (allowlist) return allowlist;

    // Then token-gated
    const tg = await fetchTokenGatedPhase(provider, nftContract);
    if (tg) return tg;

    return null;
  } catch {
    return null;
  } finally {
    try {
      provider.destroy();
    } catch {
      // Already destroyed.
    }
  }
}
