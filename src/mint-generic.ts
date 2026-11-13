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
import { withRpcTimeout, DEFAULT_READ_TIMEOUT_MS } from "./rpc-timeout";

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

// ── Pre-mint contract safety screen ─────────────────────────────────────────
//
// The generic path mints into a contract we did NOT positively identify. This
// screen answers two questions before any calldata is built: what the contract
// is, and what privileges it carries.
//
// The rule that shapes every finding: a finding must be backed by POSITIVE
// on-chain evidence. Anything the chain does not answer stays `null` and is
// reported as unknown — never as safe, and never as a number. A probe that
// reverts means "this contract does not expose that function", which is not the
// same as "the contract is fine".
//
// Only three findings refuse. Each is a definite answer from the chain that
// disqualifies the target, not a suspicion:
//   - no bytecode at the address             (an EOA cannot mint)
//   - an EIP-7702 delegated EOA              (bytecode, but not a contract)
//   - ERC165 is answered and no NFT standard is claimed (not an NFT)
//
// A fourth verdict, "unknown", is not a finding at all: it means the contract
// could not be read. It blocks for the same reason a refusal does — an
// unanswered probe is not evidence of safety.
//
// Everything else — an owner that can still change the mint, a paused contract,
// an exhausted supply, an upgradeable implementation slot — is a warning.
// Legitimate projects have all of those, so refusing on them would silently
// drop real targets; reporting them lets the caller decide.

export type ScreenLevel = "refuse" | "warn" | "info";

export interface ScreenFinding {
  level: ScreenLevel;
  /** Stable machine-readable code, e.g. "owner-privileges". */
  code: string;
  detail: string;
}

export interface ContractScreen {
  address: string;
  isContract: boolean;
  /** True when the runtime bytecode is an EIP-7702 delegation designator. */
  delegatedEoa: boolean;
  /** True when supportsInterface answered at all (any of the three IDs). */
  erc165Supported: boolean;
  erc721: boolean;
  erc1155: boolean;
  erc20: boolean;
  /** owner() when the contract exposes one; null when absent or unreadable. */
  owner: string | null;
  ownerRenounced: boolean | null;
  paused: boolean | null;
  name: string | null;
  symbol: string | null;
  totalSupply: bigint | null;
  maxSupply: bigint | null;
  /** EIP-1967 implementation address, when the slot is set. */
  eip1967Implementation: string | null;
  findings: ScreenFinding[];
  /**
   * "pass" / "warn" — the contract was read and may be minted into (warnings
   * printed). "refuse" — the chain gave a definite answer that disqualifies it.
   * "unknown" — the contract could not be read, so nothing is known about it.
   *
   * "unknown" blocks for the same reason "refuse" does: an unanswered probe is
   * not evidence of safety, and a contract we cannot read is not one we should
   * build a transaction for.
   */
  verdict: "refuse" | "warn" | "pass" | "unknown";
}

/**
 * ERC165 interface IDs. Verified against the ERC165 spec and OpenZeppelin's
 * SupportsInterfaceWithLookup — the IDs are derived from the function
 * selectors, so they are canonical rather than convention.
 */
const ERC165_INTERFACE_IDS = {
  erc721: "0x80ac58cd",
  erc1155: "0xd9b67a26",
  erc20: "0x36372b07",
} as const;

/**
 * EIP-1967 logic implementation slot. A non-zero value is positive evidence the
 * contract is a proxy whose logic can be replaced. This is the only proxy signal
 * that does not depend on guessing a proxy pattern — and it is a positive-only
 * test: an unset slot says nothing, because many proxies use other patterns.
 */
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_WORD = "0x" + "0".repeat(64);

type ViewReturns = "bool" | "address" | "string" | "uint256";

function finishScreen(screen: ContractScreen, unreadable: boolean): ContractScreen {
  const levels = new Set(screen.findings.map((f) => f.level));
  screen.verdict = unreadable
    ? "unknown"
    : levels.has("refuse")
      ? "refuse"
      : levels.has("warn")
        ? "warn"
        : "pass";
  return screen;
}

/**
 * Read one view function from the contract.
 *
 * Returns null when the contract does not expose the function, when the call
 * reverts, or when the budget ran out. Those are deliberately indistinguishable
 * to the caller: each means "no answer", and the screen treats no answer as
 * unknown rather than as a negative.
 */
async function readView(
  provider: JsonRpcProvider,
  contract: string,
  sig: string,
  returns: ViewReturns,
  label: string,
  budget: () => number,
  probe: <T>(label: string, fn: (timeoutMs: number) => Promise<T>) => Promise<T | null>
): Promise<unknown | null> {
  const name = sig.split("(")[0];
  const iface = new Interface([`function ${sig} view returns (${returns})`]);
  return probe(label, async (timeoutMs) => {
    const data = iface.encodeFunctionData(name);
    const raw = await withRpcTimeout(provider.call({ to: contract, data }), timeoutMs, label);
    return iface.decodeFunctionResult(name, raw)[0];
  });
}

/**
 * Screen a contract before minting into it.
 *
 * Read-only: eth_getCode, eth_call, eth_getStorageAt. Nothing here signs or
 * broadcasts. The whole screen runs under one deadline, spent per probe, so a
 * blackholed endpoint degrades the screen to "unknown" instead of hanging it.
 */
export async function screenMintContract(
  contract: string,
  provider: JsonRpcProvider,
  opts: { timeoutMs?: number } = {}
): Promise<ContractScreen> {
  // One deadline for the whole screen. Ten probes at the full 15 s default
  // would otherwise let a dead endpoint hold the caller for two and a half
  // minutes.
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS * 2);
  const budget = () => Math.max(0, deadline - Date.now());
  let skipped = false;

  const probe = async <T>(
    label: string,
    fn: (timeoutMs: number) => Promise<T>
  ): Promise<T | null> => {
    const left = budget();
    if (left < 200) {
      skipped = true;
      return null;
    }
    try {
      return await fn(left);
    } catch {
      // Revert, timeout, transport failure — all mean "no answer".
      return null;
    }
  };

  const findings: ScreenFinding[] = [];
  const screen: ContractScreen = {
    address: contract,
    isContract: false,
    delegatedEoa: false,
    erc165Supported: false,
    erc721: false,
    erc1155: false,
    erc20: false,
    owner: null,
    ownerRenounced: null,
    paused: null,
    name: null,
    symbol: null,
    totalSupply: null,
    maxSupply: null,
    eip1967Implementation: null,
    findings,
    verdict: "unknown",
  };

  // ── 1. Is there code? ────────────────────────────────────────────────────
  // An eth_call to an EOA with arbitrary calldata SUCCEEDS — there is no code
  // to revert — so every EOA would otherwise look like it has a mint function.
  const code = await probe("eth_getCode", (t) =>
    withRpcTimeout(provider.getCode(contract), t, "eth_getCode")
  );
  if (code === null) {
    // A failed read is not evidence about the contract. Report it as such.
    findings.push({
      level: "info",
      code: "code-unreadable",
      detail: "eth_getCode did not answer — the contract could not be screened. This is a transport failure, not a verdict.",
    });
    return finishScreen(screen, true);
  }
  if (code === "0x" || code.length <= 2) {
    findings.push({
      level: "refuse",
      code: "not-a-contract",
      detail: "No bytecode at this address — an EOA or an undeployed contract cannot mint an NFT.",
    });
    return finishScreen(screen, false);
  }
  screen.isContract = true;

  if (/^0xef0100/i.test(code)) {
    screen.delegatedEoa = true;
    findings.push({
      level: "refuse",
      code: "delegated-eoa",
      detail: "EIP-7702 delegation designator (0xef0100…) — this is an EOA with delegated execution, not a mintable contract.",
    });
    return finishScreen(screen, false);
  }

  // ── 2. What standard does it declare? ────────────────────────────────────
  const supports = (id: string) =>
    probe(`supportsInterface(${id})`, (t) =>
      withRpcTimeout(
        provider.call({ to: contract, data: "0x01ffc9a7" + id.slice(2) }),
        t,
        `supportsInterface(${id})`
      )
    );

  const [erc721Raw, erc1155Raw, erc20Raw] = await Promise.all([
    supports(ERC165_INTERFACE_IDS.erc721),
    supports(ERC165_INTERFACE_IDS.erc1155),
    supports(ERC165_INTERFACE_IDS.erc20),
  ]);
  const erc721 = erc721Raw === "0x" + "0".repeat(63) + "1";
  const erc1155 = erc1155Raw === "0x" + "0".repeat(63) + "1";
  const erc20 = erc20Raw === "0x" + "0".repeat(63) + "1";
  screen.erc721 = erc721;
  screen.erc1155 = erc1155;
  screen.erc20 = erc20;
  screen.erc165Supported =
    erc721Raw !== null || erc1155Raw !== null || erc20Raw !== null;

  if (screen.erc165Supported) {
    if (erc721) {
      findings.push({
        level: "info",
        code: "erc721",
        detail: "ERC165 identifies this contract as ERC721.",
      });
    }
    if (erc1155) {
      findings.push({
        level: "info",
        code: "erc1155",
        detail: "ERC165 identifies this contract as ERC1155.",
      });
    }
    // A contract that ANSWERS supportsInterface and claims no NFT standard has
    // told us it is not an NFT. That is a positive answer, not a silence: an
    // ERC721 that implements ERC165 always registers ERC721, because that is
    // the interface it exists to expose. Minting a fungible token is a wrong
    // target, not a failed mint, so this refuses.
    if (!erc721 && !erc1155) {
      findings.push({
        level: "refuse",
        code: erc20 ? "erc20-not-nft" : "not-an-nft-standard",
        detail: erc20
          ? "The contract declares ERC20 and no NFT standard — a fungible token, not an NFT. Minting here would buy tokens, not an NFT."
          : "The contract implements ERC165 but claims neither ERC721 nor ERC1155 — by its own declaration it is not an NFT, so minting here would buy a different kind of token.",
      });
    }
  } else {
    findings.push({
      level: "info",
      code: "erc165-absent",
      detail: "No ERC165 answer — the contract does not declare a standard. Older NFTs often omit it; the standard is unknown, not assumed.",
    });
  }

  // ── 3. Who controls it, and can it be shut off? ──────────────────────────
  const owner = await readView(
    provider, contract, "owner()", "address", "owner()", budget, probe
  );
  if (typeof owner === "string" && owner.length === 42) {
    screen.owner = owner;
    if (owner.toLowerCase() === ZERO_ADDRESS) {
      screen.ownerRenounced = true;
      findings.push({
        level: "info",
        code: "owner-renounced",
        detail: "owner() is the zero address — ownership is renounced, so a deployer cannot change the mint parameters.",
      });
    } else {
      findings.push({
        level: "warn",
        code: "owner-privileges",
        detail: `owner() is ${owner} — the deployer keeps privileges and can change the mint price or limits, or pause the sale, after you mint.`,
      });
    }
  }

  const paused = await readView(
    provider, contract, "paused()", "bool", "paused()", budget, probe
  );
  if (typeof paused === "boolean") {
    screen.paused = paused;
    findings.push(
      paused
        ? {
            level: "warn",
            code: "paused",
            detail: "paused() is true — the contract is paused and the mint will revert until it is unpaused.",
          }
        : { level: "info", code: "not-paused", detail: "paused() is false." }
    );
  }

  // ── 4. Supply ───────────────────────────────────────────────────────────
  const totalSupply = await readView(
    provider, contract, "totalSupply()", "uint256", "totalSupply()", budget, probe
  );
  const maxSupply = await readView(
    provider, contract, "maxSupply()", "uint256", "maxSupply()", budget, probe
  );
  if (typeof totalSupply === "bigint") screen.totalSupply = totalSupply;
  if (typeof maxSupply === "bigint") screen.maxSupply = maxSupply;
  if (
    screen.totalSupply !== null &&
    screen.maxSupply !== null &&
    screen.maxSupply > 0n &&
    screen.totalSupply >= screen.maxSupply
  ) {
    findings.push({
      level: "warn",
      code: "supply-exhausted",
      detail: `totalSupply ${screen.totalSupply} reached maxSupply ${screen.maxSupply} — minting is closed.`,
    });
  }

  // ── 5. Metadata ─────────────────────────────────────────────────────────
  const name = await readView(
    provider, contract, "name()", "string", "name()", budget, probe
  );
  const symbol = await readView(
    provider, contract, "symbol()", "string", "symbol()", budget, probe
  );
  if (typeof name === "string") screen.name = name;
  if (typeof symbol === "string") screen.symbol = symbol;
  if (screen.name === null && screen.symbol === null) {
    findings.push({
      level: "info",
      code: "no-metadata",
      detail: "Neither name() nor symbol() answers — the token may not display on marketplaces. Absence is not evidence of a problem.",
    });
  }

  // ── 6. Upgradeable? ─────────────────────────────────────────────────────
  const slot = await probe("EIP-1967 implementation slot", (t) =>
    withRpcTimeout(
      provider.getStorage(contract, EIP1967_IMPLEMENTATION_SLOT),
      t,
      "EIP-1967 implementation slot"
    )
  );
  if (typeof slot === "string" && slot !== ZERO_WORD && slot !== "0x") {
    screen.eip1967Implementation = "0x" + slot.slice(-40);
    findings.push({
      level: "warn",
      code: "upgradeable-proxy",
      detail: `EIP-1967 implementation slot is set (${screen.eip1967Implementation}) — the mint logic can be replaced by the proxy owner after you mint.`,
    });
  }

  if (skipped) {
    findings.push({
      level: "info",
      code: "screen-incomplete",
      detail: "The screen budget ran out before every probe completed — the unanswered fields are unknown, not clear.",
    });
  }

  return finishScreen(screen, skipped);
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
  /**
   * True when the contract screen blocked the target — either a definite
   * refusal or an unreadable contract. Always present: a plan without a screen
   * is not safe to sign.
   */
  screenRefused: boolean;
  screen: ContractScreen;
}

/**
 * Build a generic mint plan for a contract.
 *
 * Order: screen the contract, detect the mint function, read the price, encode,
 * simulate, estimate gas. The simulation result is returned rather than thrown
 * so the caller can decide — but simulationReverted: true means the tx will fail.
 *
 * A refused screen returns a minimal plan rather than null, so the caller can
 * see WHY the contract was refused instead of only that it produced nothing.
 */
export async function buildGenericMintTx(
  contract: string,
  provider: JsonRpcProvider,
  from: string,
  amount: bigint,
  opts: { proof?: string[]; signature?: string } = {}
): Promise<GenericMintPlan | null> {
  const screen = await screenMintContract(contract, provider);
  // "refuse" is a definite disqualification; "unknown" means the contract could
  // not be read. Both block — an unanswered probe is not evidence of safety.
  if (screen.verdict !== "pass" && screen.verdict !== "warn") {
    return {
      to: contract,
      data: "0x",
      value: 0n,
      selector: "(blocked)",
      price: 0n,
      gas: { gasLimit: 0n },
      simulationReverted: false,
      screenRefused: true,
      screen,
    };
  }

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
    screenRefused: false,
    screen,
  };
}

/** True when the plan is safe to sign and broadcast. */
export function isPlanBroadcastable(plan: GenericMintPlan): boolean {
  // The screen blocks on positive evidence (no code, delegated EOA, not an NFT)
  // AND on an unreadable contract — "unknown" is not "safe". The simulation
  // blocks on a revert. Either one is a hard stop.
  return !plan.screenRefused && !plan.simulationReverted;
}
