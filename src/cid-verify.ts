import { createHash } from "node:crypto";

/**
 * CID verification for IPFS metadata.
 *
 * A gateway's `etag` or `x-ipfs-roots` header is an assertion, not proof. The
 * only check that matters is: hash the bytes we actually fetched and compare
 * the digest with the CID the CONTRACT gave us. Path-based metadata URLs do
 * not expose the child CID, so those documents honestly read UNKNOWN.
 */

export type CidVerdict = "verified" | "mismatch" | "unknown";

export interface CidVerification {
  verdict: CidVerdict;
  gateway: string | null;
  bytes: number;
  reason: string | null;
}

const SHA256_CODE = 0x12;
const DIGEST_LEN = 32;
const RAW_CODEC = 0x55;
const DAG_PB_CODEC = 0x70;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  let zeros = 0;
  for (const ch of s) {
    const idx = B58.indexOf(ch);
    if (idx < 0) throw new Error("invalid base58");
    if (idx === 0 && n === 0n) { zeros++; continue; }
    n = n * 58n + BigInt(idx);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = new Uint8Array(zeros + hex.length / 2);
  for (let i = 0; i < hex.length / 2; i++) out[zeros + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base32Decode(s: string): Uint8Array {
  if (!s.startsWith("b")) throw new Error("not a CIDv1 string");
  let value = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of s.slice(1).replace(/=+$/, "")) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

function readVarint(bytes: Uint8Array, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = start;
  for (; i < bytes.length && shift < 32; i++) {
    const b = bytes[i];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [value, i + 1];
    shift += 7;
  }
  throw new Error("truncated varint");
}

/** Extract the sha2-256 digest from a CIDv0 or CIDv1 raw/dag-pb CID. */
export function cidDigest(cid: string): Uint8Array | null {
  const s = String(cid ?? "").replace(/^ipfs:\/\//, "").split(/[/?#]/)[0];
  try {
    if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s)) {
      const b = base58Decode(s);
      return b.length === 34 && b[0] === SHA256_CODE && b[1] === DIGEST_LEN ? b.slice(2) : null;
    }
    if (/^b[a-z2-7]+$/.test(s)) {
      const b = base32Decode(s);
      const [version, vEnd] = readVarint(b, 0);
      const [codec, cEnd] = readVarint(b, vEnd);
      if (version !== 1 || (codec !== RAW_CODEC && codec !== DAG_PB_CODEC)) return null;
      const [code, hEnd] = readVarint(b, cEnd);
      const [len, dStart] = readVarint(b, hEnd);
      if (code !== SHA256_CODE || len !== DIGEST_LEN || dStart + DIGEST_LEN !== b.length) return null;
      return b.slice(dStart, dStart + DIGEST_LEN);
    }
  } catch {
    return null;
  }
  return null;
}

/** Pure byte check — the tight, deterministic seam. */
export function verifyIpfsBytes(cid: string, bytes: Uint8Array): CidVerdict {
  const expected = cidDigest(cid);
  if (!expected) return "unknown";
  const actual = createHash("sha256").update(bytes).digest();
  return actual.equals(Buffer.from(expected)) ? "verified" : "mismatch";
}

/**
 * Fetch the exact raw block for a direct CID and verify it. Bounded to two
 * gateways, a small byte cap, and manual redirects. Failure is UNKNOWN.
 */
export async function verifyIpfsDocument(
  cid: string,
  gateways: string[],
  timeoutMs = 5000,
  maxBytes = 1024 * 1024
): Promise<CidVerification> {
  const bare = String(cid ?? "").replace(/^ipfs:\/\//, "").split(/[/?#]/)[0];
  for (const raw of gateways.slice(0, 2)) {
    const gateway = raw.replace(/\/+$/, "");
    try {
      const r = await fetch(`${gateway}/ipfs/${bare}?format=raw`, {
        headers: { accept: "application/vnd.ipld.raw" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      if (!r.ok || r.status >= 300) continue;
      const declared = Number(r.headers?.get?.("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) continue;
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > maxBytes) continue;
      const verdict = verifyIpfsBytes(bare, bytes);
      return {
        verdict,
        gateway,
        bytes: bytes.length,
        reason: verdict === "mismatch" ? "gateway bytes do not hash to the trusted CID" : null,
      };
    } catch {
      // Another gateway, or UNKNOWN if neither answers.
    }
  }
  return { verdict: "unknown", gateway: null, bytes: 0, reason: "no trustless gateway returned verifiable bytes" };
}
