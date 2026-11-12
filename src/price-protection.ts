// ── Price protection ────────────────────────────────────────────────────────
//
// The TS port had NO price protection anywhere. A drop whose price is raised
// between the moment we read it and the moment we fire would be minted at the
// new price with no warning — the failure mode is paying more than intended,
// silently.
//
// Protection works by locking the price observed at planning time and asserting
// against it before broadcast. It is not a substitute for simulation: a price
// change usually makes the tx revert (wrong value), but a drop that switched to
// a HIGHER price with the same value would not revert — it would just mint at
// the wrong rate. The assertion catches that.

import { parseEther, formatEther } from "ethers";

export interface PriceProtectionResult {
  isUnlimited: boolean;
  maxPriceWei: bigint | null;
  maxPriceEth: string | null;
  unitPriceEth?: string;
  display: string;
}

/**
 * Parse a user-supplied max-price spec.
 *
 * Accepted forms:
 *   0.01 | 0.01eth | 0.05/unit | 0.05total | free | 0 | any | none | unlimited
 *
 * `amount` is the quantity being minted — a per-unit spec is multiplied up to a
 * total, so the assertion compares totals consistently.
 */
export function parsePriceSpec(spec: string, amount = 1): PriceProtectionResult | null {
  if (!spec) return null;
  const s = String(spec).trim().toLowerCase();

  if (["any", "none", "unlimited"].includes(s)) {
    return { isUnlimited: true, maxPriceWei: null, maxPriceEth: null, display: "disabled (unlimited)" };
  }

  if (s === "free" || s === "0" || s === "0eth") {
    return {
      isUnlimited: false,
      maxPriceWei: 0n,
      maxPriceEth: "0",
      unitPriceEth: "0",
      display: "FREE (0 ETH)",
    };
  }

  const isTotal = s.endsWith("total");
  const clean = s.replace(/eth$/, "").replace(/\/unit$/, "").replace(/total$/, "").trim();
  const num = Number(clean);
  if (Number.isNaN(num) || num < 0 || !Number.isFinite(num)) {
    throw new Error(`invalid max-price spec: "${spec}"`);
  }
  // Number() accepts forms parseEther() rejects — "1e5", "0x10", "Infinity" —
  // and the ethers error would name the library rather than the spec. Reject
  // them here so the message points at what the user actually typed.
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(clean)) {
    throw new Error(`invalid max-price spec: "${spec}" — use a plain decimal like 0.01`);
  }

  // A non-positive quantity cannot be multiplied up into a total, and silently
  // reading 0 as 1 would price the cap for a mint that is not happening.
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error(`invalid quantity for max-price spec: ${amount}`);
  }
  const qty = BigInt(amount);
  const parsedWei = parseEther(clean);
  const totalWei = isTotal ? parsedWei : parsedWei * qty;
  const unitWei = isTotal && qty > 0n ? totalWei / qty : parsedWei;

  return {
    isUnlimited: false,
    maxPriceWei: totalWei,
    maxPriceEth: formatEther(totalWei),
    unitPriceEth: formatEther(unitWei),
    display: `${formatEther(totalWei)} ETH${qty > 1n ? ` (max ${formatEther(unitWei)} ETH/unit)` : ""}`,
  };
}

/**
 * Extract an optional max-price spec from a command string.
 *
 * Supported forms:
 *   --max-price 0.01 | --maxprice 0.01 | max:0.01 | max=0.01 | maxprice:0.01
 *   max:free | max:0 | max:0.05/unit | max:0.05total | max:any | max:unlimited
 *   p:0.01 | p=0.01
 *
 * Returns the spec and the string with the spec removed, so a caller can parse
 * the remainder as the mint target.
 */
export function extractMaxPriceSpec(input: string): { spec: string | null; rest: string } {
  if (!input || typeof input !== "string") return { spec: null, rest: input || "" };

  const valPattern =
    "((?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:eth)?(?:\\/unit|total)?|free|any|none|unlimited)";
  const re = new RegExp(
    `(?:(?:^|(?<=\\s))(?:--max-price|--maxprice)|\\b(?:max-price|maxprice|max))[:=\\s]+${valPattern}\\b|\\bp[:=]${valPattern}\\b`,
    "i"
  );

  const m = input.match(re);
  if (!m) return { spec: null, rest: input.trim() };

  const val = m[1] || m[2];
  const idx = m.index ?? 0;
  const rest = (input.slice(0, idx) + input.slice(idx + m[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return { spec: val.toLowerCase(), rest };
}

/**
 * Assert that the actual price does not exceed the maximum.
 * Throws with an informative message when it does.
 */
export function assertPriceProtection(args: {
  actualPriceWei: bigint;
  maxPriceWei: bigint | null | undefined;
  context?: string;
}): void {
  const { actualPriceWei, maxPriceWei, context = "" } = args;
  if (maxPriceWei == null) return;
  if (BigInt(actualPriceWei) > BigInt(maxPriceWei)) {
    const actualEth = formatEther(actualPriceWei);
    const maxEth = formatEther(maxPriceWei);
    const ctx = context ? ` [${context}]` : "";
    throw new Error(
      `price protection${ctx}: mint price (${actualEth} ETH) exceeds the maximum (${maxEth} ETH)`
    );
  }
}

