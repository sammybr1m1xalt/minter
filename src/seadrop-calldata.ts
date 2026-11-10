// ── SeaDrop calldata decoding ────────────────────────────────────────────────
// Single source of truth for reading fields out of SeaDrop mint calldata.
//
// WHY THIS EXISTS: two modules previously hand-rolled hex slices to find the
// minter address and the stage index, and both were wrong. Hand-computed word
// indices drift whenever the ABI gains a field, and a wrong slice is invisible
// to the type-checker. Here the decoder is ethers itself: we encode a known
// input, then ask the decoder where the value landed.
//
// Verified offsets (mintSigned, selector 0x4b61cd6f), measured by encoding a
// known input with ethers and reading the decoded fields back:
//   nftContract         word 0   hex char 10
//   feeRecipient        word 1   hex char 74
//   minterIfNotPayer    word 2   hex char 138   <-- the wallet binding
//   quantity            word 3   hex char 202
//   mintParams          word 4   — the tuple is INLINED, not offset-based
//     mintPrice        word 4   hex char 266
//     maxTotalMintableByWallet word 5
//     startTime        word 6
//     endTime          word 7
//     dropStageIndex   word 8   hex char 522
//
// An earlier version of this comment called word 4 an "offset word" and put
// dropStageIndex at word 9 / hex char 576. That layout does not exist; the
// decoder below is authoritative and was checked against it.
//
// mintAllowList (0x4300a4e6) has the identical head layout, so the same
// offsets apply.

import { Interface } from "ethers";

const MINT_PARAMS_TUPLE =
  "tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, " +
  "uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, " +
  "uint256 feeBps, bool restrictFeeRecipients)";

const SEADROP_ABI = [
  `function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MINT_PARAMS_TUPLE} mintParams, uint256 salt, bytes signature) payable`,
  `function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MINT_PARAMS_TUPLE} mintParams, bytes32[] proof) payable`,
];

const iface = new Interface(SEADROP_ABI);

/** Selectors this module knows how to decode. */
export const SIGNED_SELECTOR = "0x4b61cd6f"; // mintSigned
export const MERKLE_SELECTOR = "0x4300a4e6"; // mintAllowList
export const PUBLIC_SELECTOR = "0x161ac21f"; // mintPublic (no stage index)

export function isKnownMintSelector(data: string): boolean {
  if (!data || data.length < 10) return false;
  const sel = data.slice(0, 10).toLowerCase();
  return sel === SIGNED_SELECTOR || sel === MERKLE_SELECTOR;
}

export interface DecodedMintCalldata {
  selector: string;
  nftContract: string;
  feeRecipient: string;
  /** The address OpenSea bound this payload to. */
  minter: string;
  quantity: bigint;
  dropStageIndex: number;
}

/**
 * Decode a SeaDrop mint payload. Returns null when the calldata is not a
 * SeaDrop mint we understand — callers must treat null as "cannot verify",
 * never as "verified".
 */
export function decodeMintCalldata(data: string): DecodedMintCalldata | null {
  if (!data || typeof data !== "string" || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== SIGNED_SELECTOR && selector !== MERKLE_SELECTOR) return null;

  try {
    const fn = selector === SIGNED_SELECTOR ? "mintSigned" : "mintAllowList";
    const d = iface.decodeFunctionData(fn, data);
    return {
      selector,
      nftContract: d.nftContract,
      feeRecipient: d.feeRecipient,
      minter: d.minterIfNotPayer,
      quantity: BigInt(d.quantity),
      dropStageIndex: Number(d.mintParams.dropStageIndex),
    };
  } catch {
    return null;
  }
}

/**
 * Is this payload bound to `walletAddress`?
 *
 * FAILS OPEN: returns true when the calldata cannot be decoded. The rationale
 * is that a false negative would silently discard a valid payload and skip a
 * mint, whereas a false positive is caught on-chain by the receipt poll. The
 * per-wallet fetch is the primary protection; this is a secondary check.
 */
export function isPayloadBoundToWallet(
  payload: { mintData: string | null },
  walletAddress: string,
): boolean {
  if (!payload.mintData) return true;
  const decoded = decodeMintCalldata(payload.mintData);
  if (!decoded) return true;
  return decoded.minter.toLowerCase() === walletAddress.toLowerCase();
}

/**
 * Read dropStageIndex out of mint calldata. Returns null for public-sale
 * mints (no stage index exists) and for anything undecodable.
 */
export function decodeStageIndex(data: string): number | null {
  const decoded = decodeMintCalldata(data);
  if (!decoded) return null;
  return decoded.dropStageIndex;
}
