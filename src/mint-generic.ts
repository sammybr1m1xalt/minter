// ── Generic mint engine ─────────────────────────────────────────────────────
//
// Handles contracts that are NOT a known platform (not SeaDrop, not an OpenSea
// drop, not scatter, not Manifold). It probes the contract for a mint function,
// reads its price, builds calldata, simulates, and returns a signed-ready plan.
//
// ────────────────────────────────────────────────────────────────────────────
// SAFETY — read this before changing anything
// ────────────────────────────────────────────────────────────────────────────
// A generic mint is a state-changing transaction built from a contract we did
// NOT positively identify. That is inherently riskier than a known-platform
// path, so these rules are load-bearing:
//
//   1. NEVER encode a parameter that cannot be derived safely. If a selector
//      needs a merkle proof or an EIP-712 signature and none is configured,
//      SKIP it and say why. Guessing a bytes32[] or a signature burns gas on a
//      revert at best.
//   2. SIMULATE before returning a plan. provider.call() with the exact tx.
//      A revert is a hard stop, not a warning.
//   3. The probe distinguishes "selector does not exist" from "selector exists
//      but reverted on state/payment". A revert WITH data means the function is
//      there; a revert with NO data means it is not. See detectMintFunction.
//   4. Every selector hash in MINT_SIGNATURES is verified against
//      ethers id(sig).slice(2,10) by tests/audit-fixes.test.js. A hand-typed
//      hash fails silently — the probe never matches and the symptom looks like
//      "contract has no mint function" rather than "our table is wrong".

import { id as keccakId, Interface, JsonRpcProvider } from "ethers";
import { autoGasBounded } from "./auto-gas";
import { SEADROP_ADDRESS } from "./seadrop-public";

// ── Selector registry ───────────────────────────────────────────────────────
//
// Every hash below was computed with ethers id(sig).slice(2,10) and verified
// 2026-11-06. Do not hand-type a hash — compute it.
//
// `needs` declares what the selector requires beyond a quantity:
//   undefined        — fully synthesizable from (to, amount)
//   "proof"          — needs a bytes32[] merkle proof; SKIP without a source
//   "signature"      — needs an EIP-712/EIP-2612 signature; SKIP without one
//
// Order is by specificity: more specific signatures first, so a contract that
// exposes several is matched on the most likely one.

export interface MintSelector {
  sig: string;
  /** Verified 4-byte selector. */
  selector: string;
  /** Argument roles, in ABI order. */
  args: ("to" | "amount" | "id" | "data" | "proof" | "signature" | "recipient")[];
  /**
   * What the selector needs beyond a scalar (to, amount) before it can be
   * encoded safely:
   *   undefined      — fully synthesizable
   *   "proof"        — needs a bytes32[] merkle proof
   *   "signature"    — needs an off-chain signature
   *   "structured"   — needs arguments we cannot derive from a scalar quantity
   *                    (array-batch forms, referral addresses, tokenURI strings,
   *                    per-wallet max values). The ABI-driven path in
   *                    abi-mint.ts handles these by reading real param names.
   */
  needs?: "proof" | "signature" | "structured";
  /** Higher = tried earlier when two selectors both match. */
  weight: number;
}

function sel(
  sig: string,
  args: MintSelector["args"],
  needs: MintSelector["needs"],
  weight: number
): MintSelector {
  return { sig, selector: selectorFor(sig), args, needs, weight };
}

/** Compute a selector from a signature. Throws on an invalid signature. */
export function selectorFor(sig: string): string {
  return keccakId(sig).slice(0, 10);
}

export const MINT_SIGNATURES: MintSelector[] = [
  // ── ERC721 / simple public mint ────────────────────────────────────────
  sel("mintPublic(uint256)", ["amount"], undefined, 100),
  sel("publicMint(uint256)", ["amount"], undefined, 95),
  sel("mint(uint256)", ["amount"], undefined, 90),
  sel("claim(uint256)", ["amount"], undefined, 85),
  sel("mint(address,uint256)", ["to", "amount"], undefined, 80),
  sel("claim(address,uint256)", ["to", "amount"], undefined, 75),
  sel("mintSeaDrop(address,uint256)", ["to", "amount"], undefined, 70),
  sel("safeMint(address,uint256)", ["to", "amount"], undefined, 65),
  sel("mintNFT(uint256)", ["amount"], undefined, 60),
  sel("mintNFT(address,uint256)", ["to", "amount"], undefined, 55),
  sel("mintTo(address,uint256)", ["to", "amount"], undefined, 50),
  sel("mintFor(address,uint256)", ["to", "amount"], undefined, 45),
  sel("mint()", [], undefined, 40),
  sel("claim()", [], undefined, 35),
  sel("purchase(uint256)", ["amount"], undefined, 30),
  sel("buy(uint256)", ["amount"], undefined, 25),
  sel("freeMint()", [], undefined, 20),
  sel("freeMint(uint256)", ["amount"], undefined, 18),

  // ── ERC1155 ────────────────────────────────────────────────────────────
  sel("mint(address,uint256,uint256,bytes)", ["to", "id", "amount", "data"], undefined, 78),
  sel("mintBatch(address,uint256[])", ["to", "amount"], undefined, 58),
  sel("batchMint(address,uint256[])", ["to", "amount"], undefined, 57),
  sel("mintBaseBatch(address,uint256[])", ["to", "amount"], undefined, 56),

  // ── allowlist / merkle-proof variants ──────────────────────────────────
  // These need a bytes32[] proof. Without a proof source they are SKIPPED.
  sel("whitelistMint(uint256,bytes32[])", ["amount", "proof"], "proof", 92),
  sel("mintAllowlist(uint256,bytes32[])", ["amount", "proof"], "proof", 91),
  sel("mintAllowList(uint256,bytes32[])", ["amount", "proof"], "proof", 90),
  sel("mintWhitelist(uint256,bytes32[])", ["amount", "proof"], "proof", 89),
  sel("mintAllowList(address,uint256,bytes32[])", ["to", "amount", "proof"], "proof", 88),
  sel("mintWhitelist(address,uint256,bytes32[])", ["to", "amount", "proof"], "proof", 87),
  sel("mintPublic(uint256,bytes32[])", ["amount", "proof"], "proof", 86),
  sel("mintPublic(uint256,uint256,bytes32[])", ["amount", "id", "proof"], "proof", 85),
  sel("publicMint(uint256,bytes32[])", ["amount", "proof"], "proof", 84),

  // ── signature / lazy-mint variants ─────────────────────────────────────
  // These need an off-chain signature. Without a signer they are SKIPPED.
  sel("mintWithSignature(uint256,bytes)", ["amount", "signature"], "signature", 83),
  sel("mintSigned(uint256,bytes)", ["amount", "signature"], "signature", 82),
  sel("mintSigned(address,uint256,bytes)", ["to", "amount", "signature"], "signature", 81),
  sel("mintWithSignature(address,uint256,bytes)", ["to", "amount", "signature"], "signature", 80),
  sel("presaleMint(uint256,bytes)", ["amount", "signature"], "signature", 79),

  // ── Manifold / batch ───────────────────────────────────────────────────
  sel("claim(address,uint256,uint256,bytes)", ["to", "id", "amount", "data"], undefined, 77),

  // ── ERC1155 array-batch forms ───────────────────────────────────────────
  // `uint256[]` ids/amounts cannot be synthesized from a scalar quantity, so
  // these are marked needs-proof-style: they are SKIPPED unless the caller
  // supplies explicit arrays. See abi-mint.ts for the ABI-driven path, which
  // handles these properly by reading the real parameter names.
  sel("mint(address,uint256[],uint256[],bytes)", ["to", "amount", "data"], "structured", 76),
  sel("mintBatch(address,uint256[],uint256[],bytes)", ["to", "amount", "data"], "structured", 75),
  sel("safeBatchMint(address,uint256[],uint256[],bytes)", ["to", "amount", "data"], "structured", 74),
  sel("safeMint(address,uint256,uint256,bytes)", ["to", "id", "amount", "data"], undefined, 73),

  // ── quantity + price / max-supply forms ─────────────────────────────────
  // The second uint is a per-wallet max or a total, NOT a token id. Encoding it
  // as `id` would be silently wrong, so these are skipped by the scalar path.
  sel("mint(uint256,uint256)", ["amount", "id"], "structured", 72),
  sel("publicMint(uint256,uint256)", ["amount", "id"], "structured", 71),
  sel("mint(address,uint256,uint256)", ["to", "amount", "id"], "structured", 69),
  sel("mintPublic(uint256,uint256)", ["amount", "id"], "structured", 68),
  sel("claim(uint256,uint256)", ["amount", "id"], "structured", 67),

  // ── referral / fee forms ────────────────────────────────────────────────
  // The address is a referral, not a recipient — and it is usually required to
  // be a real referrer. Skipped rather than guessed.
  sel("mint(uint256,address)", ["amount", "to"], "structured", 66),
  sel("mint(address,uint256,address)", ["to", "amount", "to"], "structured", 64),
  sel("publicMint(uint256,address)", ["amount", "to"], "structured", 63),

  // ── tokenURI forms ─────────────────────────────────────────────────────
  // The string is metadata we cannot fabricate. Skipped.
  sel("mintTo(address,string)", ["to", "data"], "structured", 62),
  sel("mintWithTokenURI(address,string)", ["to", "data"], "structured", 61),
  sel("mint(address,string)", ["to", "data"], "structured", 59),

  // ── allowlist with max-supply ──────────────────────────────────────────
  sel("mintAllowList(uint256,uint256,bytes32[])", ["amount", "id", "proof"], "structured", 58),
  sel("mintAllowlist(uint256,uint256,bytes32[])", ["amount", "id", "proof"], "structured", 57),
  sel("whitelistMint(uint256,uint256,bytes32[])", ["amount", "id", "proof"], "structured", 56),

  // ── signature with structured args ─────────────────────────────────────
  sel("mintWithSignature(uint256,uint256,bytes)", ["amount", "id", "signature"], "signature", 55),
  sel("mintSigned(address,uint256,uint256,bytes)", ["to", "amount", "id", "signature"], "signature", 54),
  sel("purchase(uint256,bytes)", ["amount", "signature"], "signature", 53),

  // ── stage / index forms ────────────────────────────────────────────────
  sel("mint(uint256,uint8)", ["amount", "id"], "structured", 52),
  sel("mint(uint256,uint256,address)", ["amount", "id", "to"], "structured", 51),

  // ── Manifold / custom ──────────────────────────────────────────────────
  sel("purchase(address,uint256,uint256)", ["to", "amount", "id"], "structured", 50),
  sel("mintBaseNew(address,uint256,uint256,uint256,bytes)", ["to", "amount", "id", "data"], "structured", 49),
  sel("claim(address,uint256,uint256,uint256,bytes)", ["to", "amount", "id", "data"], "structured", 48),
];

// ── Price readers ───────────────────────────────────────────────────────────

export interface PriceReader {
  sig: string;
  selector: string;
  /** Some readers take a quantity argument. */
  takesAmount: boolean;
}

function pr(sig: string, takesAmount = false): PriceReader {
  return { sig, selector: selectorFor(sig), takesAmount };
}

export const PRICE_READERS: PriceReader[] = [
  pr("mintPrice()"),
  pr("price()"),
  pr("cost()"),
  pr("PRICE()"),
  pr("publicSalePrice()"),
  pr("publicPrice()"),
  pr("mintCost()"),
  pr("salePrice()"),
  pr("allowlistPrice()"),
  pr("mintPricePerToken()"),
  pr("totalPrice(uint256)", true),
];

// ── SeaDrop detection ───────────────────────────────────────────────────────

// SeaDrop has exactly one shared singleton: `SeaDrop` 1.0, which powers every
// OpenSea drop. SeaDrop v2 is not a singleton at all — v2 collections are
// per-token contracts deployed through ERC1155SeaDropCloneFactory, so there is
// no shared v2 address to probe. Verified against ProjectOpenSea/seadrop
// docs/Deployments.md.
//
// This address previously held Seaport 1.1
// (0x00000000006c3852cbef3e08e8df289169ede581) — NOT SeaDrop. Probing it for
// SeaDrop getters could never produce evidence.
export const SEADROP_V1 = SEADROP_ADDRESS;
export const SEADROP_V2 = SEADROP_V1;

// The return types use plain uintN. SeaDrop's documentation writes them as
// uint16B/uint32B (a byte-width convention), but those are NOT valid Solidity
// ABI types — ethers rejects the fragment and every call silently fails.
const SEADROP_ABI = [
  "function getPublicDrop(address nftContract) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)",
  "function getAllowListMerkleRoot(address nftContract) view returns (bytes32 root)",
  "function getCreatorPayoutAddress(address nftContract) view returns (address)",
];

export interface SeaDropDetection {
  version: "v1" | "v2" | null;
  /** True when there is POSITIVE evidence the contract is SeaDrop-managed. */
  managed: boolean;
  reason: string;
}

/**
 * Detect whether a contract is managed by a SeaDrop singleton.
 *
 * Requires POSITIVE EVIDENCE, not merely a non-reverting call: SeaDrop returns
 * an all-zero tuple for tokens it does not manage, which would otherwise look
 * like a valid (free, always-open) drop. Evidence is a configured public drop,
 * a non-zero allowlist merkle root, or a registered creator payout address.
 */
export async function isSeadropContract(
  nftContract: string,
  provider: JsonRpcProvider
): Promise<SeaDropDetection> {
  // v1 and v2 currently resolve to the one singleton (v2 has no address of its
  // own), so probe each distinct address exactly once.
  const singletons: readonly (readonly ["v1" | "v2", string])[] =
    SEADROP_V2 === SEADROP_V1
      ? [["v1", SEADROP_V1]]
      : [
          ["v2", SEADROP_V2],
          ["v1", SEADROP_V1],
        ];
  for (const [version, singleton] of singletons) {
    const seadrop = new Interface(SEADROP_ABI);
    try {
      // Public drop: mintPrice/startTime/endTime all zero means "not managed".
      const publicData = seadrop.encodeFunctionData("getPublicDrop", [nftContract]);
      const publicRaw = await provider.call({ to: singleton, data: publicData });
      const publicDecoded = seadrop.decodeFunctionResult("getPublicDrop", publicRaw);
      const mintPrice = publicDecoded.mintPrice ?? 0n;
      const startTime = publicDecoded.startTime ?? 0n;
      const endTime = publicDecoded.endTime ?? 0n;
      const hasPublicDrop = mintPrice > 0n || startTime > 0n || endTime > 0n;

      // Allowlist: a non-zero merkle root means an allowlist is configured.
      let hasAllowlist = false;
      try {
        const rootData = seadrop.encodeFunctionData("getAllowListMerkleRoot", [nftContract]);
        const rootRaw = await provider.call({ to: singleton, data: rootData });
        const rootDecoded = seadrop.decodeFunctionResult("getAllowListMerkleRoot", rootRaw);
        const root: string = rootDecoded.root ?? rootDecoded[0] ?? "0x" + "0".repeat(64);
        hasAllowlist = root !== "0x" + "0".repeat(64);
      } catch {
        hasAllowlist = false;
      }

      // Creator payout address: a non-zero address means SeaDrop knows the token.
      let hasPayout = false;
      try {
        const payoutData = seadrop.encodeFunctionData("getCreatorPayoutAddress", [nftContract]);
        const payoutRaw = await provider.call({ to: singleton, data: payoutData });
        const payoutDecoded = seadrop.decodeFunctionResult("getCreatorPayoutAddress", payoutRaw);
        const addr = payoutDecoded[0] ?? "0x0000000000000000000000000000000000000000";
        hasPayout = addr !== "0x0000000000000000000000000000000000000000";
      } catch {
        hasPayout = false;
      }

      if (hasPublicDrop || hasAllowlist || hasPayout) {
        const reasons = [
          hasPublicDrop ? "public drop configured" : null,
          hasAllowlist ? "allowlist merkle root set" : null,
          hasPayout ? "creator payout registered" : null,
        ].filter(Boolean);
        return { version, managed: true, reason: reasons.join(" + ") };
      }
    } catch {
      // Singleton call failed — try the next version.
    }
  }

  return { version: null, managed: false, reason: "no SeaDrop evidence (no public drop, no merkle root, no payout)" };
}

// ── Argument synthesis ──────────────────────────────────────────────────────

export interface SynthContext {
  to: string;
  amount: bigint;
  /**
   * Caller-supplied off-chain data. A proof or signature CANNOT be synthesized
   * from a scalar — when the selected signature needs one and the caller did not
   * supply it, buildArgs returns null and the candidate is skipped.
   */
  proof?: string[];
  signature?: string;
}

/**
 * Build the argument list for a selector.
 *
 * Returns null when a required argument cannot be synthesized safely — the
 * caller must SKIP the selector rather than guess. This is the guard that
 * prevents encoding a fabricated proof or signature.
 */
export function buildArgs(
  selector: MintSelector,
  ctx: SynthContext
): (string | bigint | string[])[] | null {
  const out: (string | bigint | string[])[] = [];
  for (const role of selector.args) {
    switch (role) {
      case "to":
      case "recipient":
        // Never the zero address: many mints revert on it.
        if (!ctx.to || /^0x0+$/.test(ctx.to)) return null;
        out.push(ctx.to);
        break;
      case "amount":
        out.push(ctx.amount > 0n ? ctx.amount : 1n);
        break;
      case "id":
        out.push(0n);
        break;
      case "data":
        out.push("0x");
        break;
      case "proof":
        // A merkle proof is caller-supplied and cannot be synthesized.
        if (!ctx.proof || ctx.proof.length === 0) return null;
        out.push(ctx.proof);
        break;
      case "signature":
        // Same: a server signature is caller-supplied.
        if (!ctx.signature) return null;
        out.push(ctx.signature);
        break;
    }
  }
  return out;
}

// ── Mint-function detection ─────────────────────────────────────────────────

export interface DetectedMint {
  selector: MintSelector;
  /** True when the probe reverted with data (exists but needs payment/proof). */
  revertedWithData: boolean;
}

/**
 * Probe candidate mint signatures via eth_call.
 *
 * The distinction that makes this work:
 *   - revert WITH data  → the selector EXISTS (it reverted on state/payment)
 *   - revert with NO data → the selector does not exist
 *
 * Selectors that need a proof or signature are only returned when the caller
 * has supplied one; otherwise they are skipped, because we cannot build their
 * calldata.
 */
export async function detectMintFunction(
  contract: string,
  provider: JsonRpcProvider,
  from: string,
  amount: bigint,
  opts: { proof?: string[]; signature?: string } = {}
): Promise<DetectedMint | null> {
  const candidates = [...MINT_SIGNATURES].sort((a, b) => b.weight - a.weight);

  // A candidate that reverts WITH data exists but needs something we did not
  // supply (payment, proof, a closed sale). Remember the first one, but keep
  // probing: a later candidate that SUCCEEDS is a strictly better answer than
  // the first one that merely exists, and returning early on a revert let a
  // high-weight paid mint shadow a free mint further down the list.
  let firstReverting: DetectedMint | null = null;

  for (const candidate of candidates) {
    if (candidate.needs === "proof" && !opts.proof) continue;
    if (candidate.needs === "signature" && !opts.signature) continue;
    // "structured" selectors need arguments a scalar quantity cannot supply.
    // The ABI-driven path (abi-mint.ts) can fill them; the scalar path cannot.
    if (candidate.needs === "structured") continue;

    const args = buildArgs(candidate, { to: from, amount, proof: opts.proof, signature: opts.signature });
    if (!args) continue;

    const iface = new Interface([`function ${candidate.sig} payable`]);
    const name = candidate.sig.split("(")[0];
    let data: string;
    try {
      data = iface.encodeFunctionData(name, args);
    } catch {
      continue;
    }

    try {
      await provider.call({ to: contract, from, data, value: 0 });
      return { selector: candidate, revertedWithData: false };
    } catch (e: any) {
      const errData = e?.data ?? e?.info?.error?.data;
      if (errData && errData !== "0x") {
        if (!firstReverting) firstReverting = { selector: candidate, revertedWithData: true };
      }
      continue;
    }
  }

  return firstReverting;
}

// ── Price detection ─────────────────────────────────────────────────────────

/**
 * Read the mint price from the contract.
 *
 * Returns null when no price reader exists. A returned 0n is ambiguous — it
 * can mean "free mint" or "reader does not exist" — so callers should treat 0
 * with caution and prefer a reader that is known to exist.
 */
export async function detectPrice(
  contract: string,
  provider: JsonRpcProvider,
  amount: bigint = 1n
): Promise<{ price: bigint; reader: string } | null> {
  for (const reader of PRICE_READERS) {
    const iface = new Interface([`function ${reader.sig}`]);
    const name = reader.sig.split("(")[0];
    try {
      const args = reader.takesAmount ? [amount] : [];
      const data = iface.encodeFunctionData(name, args);
      const raw = await provider.call({ to: contract, data });
      const decoded = iface.decodeFunctionResult(name, raw);
      const value = decoded[0];
      if (typeof value === "bigint") {
        return { price: value, reader: reader.sig };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ── Gas ─────────────────────────────────────────────────────────────────────

export interface GasPlan {
  gasLimit: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

// ── Plan builder ────────────────────────────────────────────────────────────

export interface GenericMintPlan {
  to: string;
  data: string;
  value: bigint;
  selector: string;
  price: bigint;
  gas: GasPlan;
  /** True when the simulation reverted — the plan must NOT be broadcast. */
  simulationReverted: boolean;
  simulationError?: string;
}

/**
 * Build a generic mint plan for a contract.
 *
 * Order: detect the mint function, read the price, encode, simulate, estimate
 * gas. The simulation result is returned rather than thrown so the caller can
 * decide — but simulationReverted: true means the tx will fail.
 */
export async function buildGenericMintTx(
  contract: string,
  provider: JsonRpcProvider,
  from: string,
  amount: bigint,
  opts: { proof?: string[]; signature?: string } = {}
): Promise<GenericMintPlan | null> {
  const detected = await detectMintFunction(contract, provider, from, amount, opts);
  if (!detected) return null;

  const priceInfo = await detectPrice(contract, provider, amount);
  const value = priceInfo?.price ?? 0n;

  const args = buildArgs(detected.selector, { to: from, amount, proof: opts.proof, signature: opts.signature });
  if (!args) return null;

  const iface = new Interface([`function ${detected.selector.sig} payable`]);
  const name = detected.selector.sig.split("(")[0];
  const data = iface.encodeFunctionData(name, args);

  const tx = { to: contract, from, data, value };

  // Simulate. A revert here is the single most useful signal in this module.
  let simulationReverted = false;
  let simulationError: string | undefined;
  try {
    await provider.call(tx);
  } catch (e: any) {
    simulationReverted = true;
    simulationError = e?.shortMessage ?? e?.reason ?? e?.info?.error?.message ?? e?.message ?? "unknown revert";
  }

  // Bounded and parallel. The previous local autoGas copy ran estimateGas then
  // getFeeData sequentially with no timeout, so one stalled RPC hung the plan
  // builder for ~5 minutes (ethers' FetchRequest default) — and it duplicated a
  // decision auto-gas.ts already owns.
  const gas: GasPlan = simulationReverted
    ? { gasLimit: 150_000n }
    : (await autoGasBounded(provider, tx)) ?? { gasLimit: 150_000n };

  return {
    to: contract,
    data,
    value,
    selector: detected.selector.sig,
    price: value,
    gas,
    simulationReverted,
    simulationError,
  };
}

/** True when the plan is safe to sign and broadcast. */
export function isPlanBroadcastable(plan: GenericMintPlan): boolean {
  return !plan.simulationReverted;
}
