// ── SeaDrop allowlist / merkle-proof resolution ────────────────────────────
//
// Ported from nft-minter-bot/src/allowlist.js.
//
// The TS port had NO allowlist resolution at all. It could detect that an
// allowlist phase existed (a non-zero merkle root) but could never obtain the
// proof needed to mint it — so every allowlist stage was reported as
// "check-manually" and was effectively untargetable.
//
// Flow (unchanged from the original, because it is the only way to do this):
//   1. getAllowListMerkleRoot(nftContract) — zero means no allowlist.
//   2. Scan AllowListUpdated event logs on the SeaDrop singleton for the most
//      recent allowListURI.
//   3. Download the tree JSON.
//   4. Look up the wallet — the entry already ships mintParams and the merkle
//      proof, so no local merkle computation is needed.
//
// The event topic and the mintParams tuple order are the load-bearing details;
// both were verified against the live SeaDrop contract.

import { JsonRpcProvider, Interface, zeroPadValue, getAddress } from "ethers";

// keccak256("AllowListUpdated(address,bytes32,bytes32,string[],string)")
const ALLOWLIST_UPDATED_TOPIC0 =
  "0xefcd7e019bc8b47d27881fd59e2619280ca5894f285950f10ab049870652efa5";

const ALLOWLIST_EVENT_ABI = [
  "event AllowListUpdated(address indexed nftContract, bytes32 indexed previousMerkleRoot, bytes32 indexed newMerkleRoot, string[] publicKeyURI, string allowListURI)",
];

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

function normalizeUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    return IPFS_GATEWAY + uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  }
  return uri;
}

/**
 * Fetch the most recent allowListURI emitted for nftContract on seadropAddr.
 * Returns null when no such event exists or the RPC refuses the range.
 */
export async function fetchAllowListUri(
  seadropAddr: string,
  nftContract: string,
  provider: JsonRpcProvider
): Promise<string | null> {
  const topics = [
    ALLOWLIST_UPDATED_TOPIC0,
    zeroPadValue(getAddress(nftContract), 32),
  ];

  let logs: any[];
  try {
    logs = await provider.getLogs({ address: seadropAddr, topics, fromBlock: 0, toBlock: "latest" });
  } catch {
    // RPC block-range limits, etc. — treat as unknown rather than throwing.
    return null;
  }
  if (!logs || logs.length === 0) return null;

  const iface = new Interface(ALLOWLIST_EVENT_ABI);
  const last = logs[logs.length - 1]; // most recent update wins
  try {
    const parsed = iface.parseLog(last as any);
    return normalizeUri(parsed?.args?.allowListURI);
  } catch {
    return null;
  }
}

interface AllowlistEntry {
  address?: string;
  minter?: string;
  wallet?: string;
  mintParams?: any;
  params?: any;
  proof?: string[];
  proofs?: string[];
}

interface AllowlistTree {
  root: string | null;
  byAddr: Map<string, AllowlistEntry>;
}

/**
 * Download and index the allowlist tree by lowercased address.
 * Accepts the common shapes: { allowList:[...] }, { merkleTree:[...] },
 * { entries:[...] }, or a bare array.
 */
export async function fetchTree(uri: string): Promise<AllowlistTree> {
  const r = await fetch(uri, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`allowlist fetch ${r.status}`);
  const j: any = await r.json();

  const list: AllowlistEntry[] = Array.isArray(j) ? j : j.allowList || j.merkleTree || j.entries || [];
  const byAddr = new Map<string, AllowlistEntry>();
  for (const e of list) {
    const addr = (e.address || e.minter || e.wallet || "").toLowerCase();
    if (addr) byAddr.set(addr, e);
  }
  return { root: j.merkleRoot || null, byAddr };
}

/**
 * Normalize an entry's mintParams into the 8-field tuple order SeaDrop's ABI
 * expects. Field order matters — a wrong order silently mints at the wrong
 * price or reverts.
 */
export function toMintParams(mp: any): bigint[] {
  return [
    BigInt(mp.mintPrice ?? 0),
    BigInt(mp.maxTotalMintableByWallet ?? 0),
    BigInt(mp.startTime ?? 0),
    BigInt(mp.endTime ?? 0),
    BigInt(mp.dropStageIndex ?? 0),
    BigInt(mp.maxTokenSupplyForStage ?? 0),
    BigInt(mp.feeBps ?? 0),
    BigInt(mp.restrictFeeRecipients ? 1 : 0),
  ];
}

export interface AllowlistCheck {
  eligible: boolean;
  hasAllowlist: boolean;
  reason?: string;
  mintParams?: bigint[];
  proof?: string[];
  raw?: any;
}

/**
 * Check a wallet's allowlist eligibility for a SeaDrop drop.
 *
 * `root` is the on-chain merkle root from getAllowListMerkleRoot. A zero root
 * means no allowlist is configured — the caller should mint publicly instead.
 */
export async function checkAllowlist(
  seadropAddr: string,
  nftContract: string,
  minter: string,
  provider: JsonRpcProvider,
  root: string | null
): Promise<AllowlistCheck> {
  if (!root) return { eligible: false, hasAllowlist: false };

  const uri = await fetchAllowListUri(seadropAddr, nftContract, provider);
  if (!uri) {
    return { eligible: false, hasAllowlist: true, reason: "allowListURI not found in event logs" };
  }

  let tree: AllowlistTree;
  try {
    tree = await fetchTree(uri);
  } catch (e: any) {
    return { eligible: false, hasAllowlist: true, reason: `allowlist unreachable: ${e?.message}` };
  }

  const entry = tree.byAddr.get(minter.toLowerCase());
  if (!entry) return { eligible: false, hasAllowlist: true, reason: "wallet not on allowlist" };

  const mp = entry.mintParams || entry.params;
  const proof = entry.proof || entry.proofs;
  if (!mp || !Array.isArray(proof)) {
    return { eligible: false, hasAllowlist: true, reason: "allowlist entry missing mintParams/proof" };
  }

  return { eligible: true, hasAllowlist: true, mintParams: toMintParams(mp), proof, raw: mp };
}

/**
 * Read the on-chain merkle root for a contract. Returns null when unset.
 * Exported so callers can decide between the public and allowlist paths.
 */
export async function getAllowlistRoot(
  seadropAddr: string,
  nftContract: string,
  provider: JsonRpcProvider
): Promise<string | null> {
  const iface = new Interface([
    "function getAllowListMerkleRoot(address nftContract) view returns (bytes32 root, uint96 maxTotalMintablePerWallet, uint32 startTime, uint32 endTime, uint32 mintLimitPerWallet, uint32 mintStageIndex)",
  ]);
  try {
    const data = iface.encodeFunctionData("getAllowListMerkleRoot", [nftContract]);
    const raw = await provider.call({ to: seadropAddr, data });
    const decoded = iface.decodeFunctionResult("getAllowListMerkleRoot", raw);
    const root = decoded.root ?? decoded[0];
    return /^0x0*$/.test(root) ? null : root;
  } catch {
    return null;
  }
}
