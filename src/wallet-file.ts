// ── Encrypted wallet file ────────────────────────────────────────────────────
//
// wallets.json holds raw private keys — the one place a key exists at rest in
// the clear, and the file most likely to be copied into a backup or committed
// by accident. This module wraps it in an authenticated envelope: scrypt
// derives a key from a passphrase, AES-256-GCM encrypts the previous contents
// unchanged, so the plaintext format and the encrypted one have the same shape
// underneath and an old file keeps loading.
//
// The passphrase is never stored. It comes from WALLETS_PASSPHRASE (headless)
// or an interactive prompt — never a command-line flag, which would sit in the
// shell history and in `ps` output for the life of the process.
//
// Honest scope: a passphrase that lives only in your head defends the file
// against it leaking on its own. A passphrase written in .env next to the file
// defends against nothing but a stray copy of that one file. Say so rather than
// implying more.

import * as crypto from "crypto";
import * as fs from "fs";

const ENVELOPE_VERSION = 1;
const KDF_NAME = "scrypt";
const CIPHER = "aes-256-gcm";

// scrypt work factors, recorded in the envelope so a file stays readable if
// they are ever re-tuned. 2^17 × r=8 is the OWASP recommendation for password
// storage; it costs ~128 MB and well under a second, and it runs once per
// invocation rather than per request.
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;

export interface WalletEnvelope {
  v: number;
  alg: string;
  kdf: string;
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
  /** base64 */
  nonce: string;
  /** base64, GCM tag appended */
  ct: string;
}

export type WalletFile =
  | { kind: "plain"; value: any }
  | { kind: "encrypted"; envelope: WalletEnvelope }
  | { kind: "malformed"; error: string };

export function isEnvelope(value: any): value is WalletEnvelope {
  return (
    value != null &&
    typeof value === "object" &&
    value.v === ENVELOPE_VERSION &&
    typeof value.kdf === "string" &&
    typeof value.salt === "string" &&
    typeof value.nonce === "string" &&
    typeof value.ct === "string"
  );
}

/**
 * Classify the raw text of a wallet file. Never throws: a malformed file is a
 * state the caller must report, not a reason to crash a run.
 */
export function readWalletFile(text: string): WalletFile {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    return { kind: "malformed", error: `not valid JSON: ${e?.message ?? e}` };
  }
  if (isEnvelope(parsed)) return { kind: "encrypted", envelope: parsed };
  return { kind: "plain", value: parsed };
}

function deriveKey(passphrase: string, env: WalletEnvelope): Buffer {
  return crypto.scryptSync(passphrase, Buffer.from(env.salt, "base64"), KEY_BYTES, {
    N: env.N,
    r: env.r,
    p: env.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Encrypt an already-parsed wallet payload, returning the file text to write. */
export function encryptWalletPayload(value: unknown, passphrase: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const key = crypto.scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const cipher = crypto.createCipheriv(CIPHER, key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: WalletEnvelope = {
    v: ENVELOPE_VERSION,
    alg: CIPHER,
    kdf: KDF_NAME,
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ct: Buffer.concat([ct, tag]).toString("base64"),
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Decrypt an envelope back to the original file text. Throws on a wrong
 * passphrase or a damaged body — GCM authentication is the only thing standing
 * between a typo and silently loading garbage, so it must never be swallowed.
 */
export function decryptWalletText(envelope: WalletEnvelope, passphrase: string): string {
  const key = deriveKey(passphrase, envelope);
  const raw = Buffer.from(envelope.ct, "base64");
  const TAG_BYTES = 16;
  if (raw.length < TAG_BYTES) throw new Error("encrypted wallet file is truncated.");
  const body = raw.subarray(0, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("wrong passphrase, or the encrypted wallet file is damaged.");
  }
}

/**
 * Read a wallet file's text, or null when it is absent/unreadable. Never throws:
 * a missing file is a normal state, not an error.
 */
export function readWalletFilePath(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write a wallet file so a crash cannot leave half of one behind. The temp file
 * is created owner-only and renamed into place, which is atomic on one
 * filesystem. A wallet file is written 0600 regardless of umask — the plaintext
 * and encrypted forms alike.
 */
export function writeWalletFileAtomic(filePath: string, text: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw e;
  }
}

/**
 * Classify a wallet file on disk without reading any keys out of it — for the
 * health report, which must be able to say WHY no wallets loaded rather than
 * report a bare zero.
 */
export function walletFileState(filePath: string): "absent" | "plaintext" | "encrypted" | "malformed" {
  const text = readWalletFilePath(filePath);
  if (text == null) return "absent";
  const kind = readWalletFile(text).kind;
  return kind === "plain" ? "plaintext" : kind === "encrypted" ? "encrypted" : "malformed";
}

/**
 * Pull key strings out of either wallet-file shape: a bare array, or
 * `{ wallets: [...] }`, each entry a string or `{ pk | privateKey }`.
 * Shared with the plaintext path so the two cannot drift.
 */
export function extractKeys(value: any): string[] {
  const arr = Array.isArray(value) ? value : value?.wallets;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const e of arr) {
    const k = typeof e === "string" ? e : e?.pk || e?.privateKey;
    if (typeof k === "string" && k.trim()) out.push(k.trim());
  }
  return out;
}

/**
 * Read a wallet file into key strings.
 *
 * `passphrase` is null when none is available. An encrypted file with no
 * passphrase is reported as `encrypted-locked` rather than silently yielding
 * zero keys — a run that believes it has wallets when it has none is the
 * failure mode that costs money.
 */
export function loadKeysFromFile(
  filePath: string,
  text: string,
  passphrase: string | null
): { keys: string[]; status: "plain" | "encrypted" | "encrypted-locked" | "malformed"; detail?: string } {
  const file = readWalletFile(text);
  if (file.kind === "malformed") {
    return { keys: [], status: "malformed", detail: file.error };
  }
  if (file.kind === "plain") {
    return { keys: extractKeys(file.value), status: "plain" };
  }
  if (passphrase == null || passphrase === "") {
    return {
      keys: [],
      status: "encrypted-locked",
      detail: `${filePath} is encrypted — set WALLETS_PASSPHRASE or run without a TTY to be asked`,
    };
  }
  try {
    const inner = decryptWalletText(file.envelope, passphrase);
    const parsed = readWalletFile(inner);
    if (parsed.kind !== "plain") {
      return { keys: [], status: "malformed", detail: "decrypted body is not a plain wallet file" };
    }
    return { keys: extractKeys(parsed.value), status: "encrypted" };
  } catch (e: any) {
    return { keys: [], status: "malformed", detail: e?.message ?? String(e) };
  }
}
