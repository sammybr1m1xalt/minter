"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAllowListUri = fetchAllowListUri;
exports.fetchTree = fetchTree;
exports.toMintParams = toMintParams;
exports.checkAllowlist = checkAllowlist;
exports.getAllowlistRoot = getAllowlistRoot;
const ethers_1 = require("ethers");
// keccak256("AllowListUpdated(address,bytes32,bytes32,string[],string)")
const ALLOWLIST_UPDATED_TOPIC0 = "0xefcd7e019bc8b47d27881fd59e2619280ca5894f285950f10ab049870652efa5";
const ALLOWLIST_EVENT_ABI = [
    "event AllowListUpdated(address indexed nftContract, bytes32 indexed previousMerkleRoot, bytes32 indexed newMerkleRoot, string[] publicKeyURI, string allowListURI)",
];
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
function normalizeUri(uri) {
    if (!uri)
        return null;
    if (uri.startsWith("ipfs://")) {
        return IPFS_GATEWAY + uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    }
    return uri;
}
/**
 * Fetch the most recent allowListURI emitted for nftContract on seadropAddr.
 * Returns null when no such event exists or the RPC refuses the range.
 */
async function fetchAllowListUri(seadropAddr, nftContract, provider) {
    const topics = [
        ALLOWLIST_UPDATED_TOPIC0,
        (0, ethers_1.zeroPadValue)((0, ethers_1.getAddress)(nftContract), 32),
    ];
    let logs;
    try {
        logs = await provider.getLogs({ address: seadropAddr, topics, fromBlock: 0, toBlock: "latest" });
    }
    catch {
        // RPC block-range limits, etc. — treat as unknown rather than throwing.
        return null;
    }
    if (!logs || logs.length === 0)
        return null;
    const iface = new ethers_1.Interface(ALLOWLIST_EVENT_ABI);
    const last = logs[logs.length - 1]; // most recent update wins
    try {
        const parsed = iface.parseLog(last);
        return normalizeUri(parsed?.args?.allowListURI);
    }
    catch {
        return null;
    }
}
/**
 * Download and index the allowlist tree by lowercased address.
 * Accepts the common shapes: { allowList:[...] }, { merkleTree:[...] },
 * { entries:[...] }, or a bare array.
 */
async function fetchTree(uri) {
    const r = await fetch(uri, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok)
        throw new Error(`allowlist fetch ${r.status}`);
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.allowList || j.merkleTree || j.entries || [];
    const byAddr = new Map();
    for (const e of list) {
        const addr = (e.address || e.minter || e.wallet || "").toLowerCase();
        if (addr)
            byAddr.set(addr, e);
    }
    return { root: j.merkleRoot || null, byAddr };
}
/**
 * Normalize an entry's mintParams into the 8-field tuple order SeaDrop's ABI
 * expects. Field order matters — a wrong order silently mints at the wrong
 * price or reverts.
 */
function toMintParams(mp) {
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
/**
 * Check a wallet's allowlist eligibility for a SeaDrop drop.
 *
 * `root` is the on-chain merkle root from getAllowListMerkleRoot. A zero root
 * means no allowlist is configured — the caller should mint publicly instead.
 */
async function checkAllowlist(seadropAddr, nftContract, minter, provider, root) {
    if (!root)
        return { eligible: false, hasAllowlist: false };
    const uri = await fetchAllowListUri(seadropAddr, nftContract, provider);
    if (!uri) {
        return { eligible: false, hasAllowlist: true, reason: "allowListURI not found in event logs" };
    }
    let tree;
    try {
        tree = await fetchTree(uri);
    }
    catch (e) {
        return { eligible: false, hasAllowlist: true, reason: `allowlist unreachable: ${e?.message}` };
    }
    const entry = tree.byAddr.get(minter.toLowerCase());
    if (!entry)
        return { eligible: false, hasAllowlist: true, reason: "wallet not on allowlist" };
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
async function getAllowlistRoot(seadropAddr, nftContract, provider) {
    const iface = new ethers_1.Interface([
        "function getAllowListMerkleRoot(address nftContract) view returns (bytes32 root, uint96 maxTotalMintablePerWallet, uint32 startTime, uint32 endTime, uint32 mintLimitPerWallet, uint32 mintStageIndex)",
    ]);
    try {
        const data = iface.encodeFunctionData("getAllowListMerkleRoot", [nftContract]);
        const raw = await provider.call({ to: seadropAddr, data });
        const decoded = iface.decodeFunctionResult("getAllowListMerkleRoot", raw);
        const root = decoded.root ?? decoded[0];
        return /^0x0*$/.test(root) ? null : root;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=allowlist-onchain.js.map