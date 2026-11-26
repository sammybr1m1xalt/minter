import { getAddress, id as keccakId, Interface } from "ethers";

/**
 * Verify what actually landed, not just that a transaction mined.
 *
 * Seaport's `fulfillAvailableAdvancedOrders` fills up to `maximumFulfilled`:
 * one mined transaction is NOT proof that every chosen id was bought. This
 * module reads ERC-721/ERC-1155 transfer logs to the buyer and compares them
 * with the ids the operator selected. It never assumes success from status 1.
 */

export interface ExpectedFulfillment {
  buyer: string;
  tokenIds: string[];
  /** If known, only transfers from this collection count. */
  collection?: string | null;
}

export type FulfillmentStatus = "confirmed" | "failed" | "reverted" | "timeout";

export interface FulfillmentVerification {
  status: FulfillmentStatus;
  receivedTokenIds: string[];
  missingTokenIds: string[];
  reason: string | null;
}

const ERC721_TRANSFER = keccakId("Transfer(address,address,uint256)");
const ERC1155_SINGLE = keccakId("TransferSingle(address,address,address,uint256,uint256)");
const ERC1155_BATCH = keccakId("TransferBatch(address,address,address,uint256[],uint256[])");
const ERC1155_IFACE = new Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const addrFromTopic = (t: string): string | null =>
  typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t) ? getAddress(`0x${t.slice(-40)}`) : null;

/** Pure receipt-log check — deterministic and easy to harness. */
export function verifyReceiptLogs(receipt: any, expected: ExpectedFulfillment): FulfillmentVerification {
  const status = String(receipt?.status ?? "1");
  if (status === "0" || status === "0x0") {
    return { status: "reverted", receivedTokenIds: [], missingTokenIds: [...expected.tokenIds], reason: "transaction reverted" };
  }
  const buyer = expected.buyer ? getAddress(expected.buyer) : null;
  const wanted = [...new Set(expected.tokenIds.map(String))];
  if (!buyer || !wanted.length) {
    return { status: "failed", receivedTokenIds: [], missingTokenIds: wanted, reason: "no buyer or expected token ids to verify" };
  }
  const wantedSet = new Set(wanted);
  const receivedSet = new Set<string>();
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  for (const log of logs) {
    const topic0 = String(log?.topics?.[0] ?? "").toLowerCase();
    const contract = typeof log?.address === "string" ? log.address : "";
    if (expected.collection && contract && !eq(contract, expected.collection)) continue;
    let recipient: string | null = null;
    if (topic0 === ERC721_TRANSFER.toLowerCase() && log?.topics?.length >= 4) {
      recipient = addrFromTopic(log.topics[2]);
      if (recipient && eq(recipient, buyer)) receivedSet.add(BigInt(log.topics[3]).toString());
    } else if (topic0 === ERC1155_SINGLE.toLowerCase() && log?.topics?.length >= 4) {
      recipient = addrFromTopic(log.topics[3]);
      if (recipient && eq(recipient, buyer)) {
        try {
          const parsed = ERC1155_IFACE.parseLog({ topics: log.topics, data: log.data });
          if (parsed?.name === "TransferSingle") receivedSet.add(BigInt(parsed.args.id).toString());
        } catch {
          // malformed log — not evidence of a transfer
        }
      }
    } else if (topic0 === ERC1155_BATCH.toLowerCase() && log?.topics?.length >= 4) {
      recipient = addrFromTopic(log.topics[3]);
      if (recipient && eq(recipient, buyer)) {
        try {
          const parsed = ERC1155_IFACE.parseLog({ topics: log.topics, data: log.data });
          if (parsed?.name === "TransferBatch") {
            for (const raw of parsed.args.ids) receivedSet.add(BigInt(raw).toString());
          }
        } catch {
          // malformed log — not evidence of a transfer
        }
      }
    }
  }
  const receivedTokenIds = [...receivedSet].filter((t) => wantedSet.has(t));
  const missingTokenIds = wanted.filter((t) => !receivedSet.has(t));
  if (missingTokenIds.length) {
    return {
      status: "failed",
      receivedTokenIds,
      missingTokenIds,
      reason: `transaction mined but token${missingTokenIds.length > 1 ? "s" : ""} ${missingTokenIds.join(", ")} did not reach the buyer`,
    };
  }
  return { status: "confirmed", receivedTokenIds, missingTokenIds: [], reason: null };
}

/**
 * Wait for a bounded confirmation and verify the outcome. A timeout stays
 * "timeout" — an unanswered transaction is not a failed purchase.
 */
export async function waitForFulfillment(
  provider: any,
  hash: string,
  expected: ExpectedFulfillment,
  timeoutMs = 60_000
): Promise<FulfillmentVerification> {
  let receipt: any = null;
  try {
    receipt = await provider.waitForTransaction(hash, 1, timeoutMs);
  } catch (e: any) {
    const mined = e?.receipt ?? e?.info?.receipt;
    if (mined) return verifyReceiptLogs(mined, expected);
    return {
      status: "timeout",
      receivedTokenIds: [],
      missingTokenIds: [...expected.tokenIds],
      reason: `verification inconclusive: ${e?.shortMessage ?? e?.message ?? "receipt wait failed"}`,
    };
  }
  if (!receipt) {
    return {
      status: "timeout",
      receivedTokenIds: [],
      missingTokenIds: [...expected.tokenIds],
      reason: `verification inconclusive: no receipt within ${timeoutMs}ms`,
    };
  }
  return verifyReceiptLogs(receipt, expected);
}
