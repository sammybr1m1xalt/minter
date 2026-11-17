// ── `minter wallets <status|encrypt|decrypt>` ────────────────────────────────
//
// The wallet file is the one place a private key sits at rest in the clear.
// These three verbs manage that: report which form the file is in, and convert
// between the plaintext and encrypted forms. They never print a key.

import chalk from "chalk";
import { Wallet } from "ethers";
import { askHidden } from "./prompt";
import {
  decryptWalletText,
  encryptWalletPayload,
  extractKeys,
  loadKeysFromFile,
  readWalletFile,
  readWalletFilePath,
  writeWalletFileAtomic,
} from "./wallet-file";

function walletPath(): string {
  return process.env.WALLETS_FILE || "wallets.json";
}

type Shape = { label: "plaintext" | "encrypted" | "malformed"; detail?: string; keys: string[] };

function describe(text: string): Shape {
  const file = readWalletFile(text);
  if (file.kind === "malformed") return { label: "malformed", detail: file.error, keys: [] };
  if (file.kind === "encrypted") return { label: "encrypted", keys: [] };
  return { label: "plaintext", keys: extractKeys(file.value) };
}

function showWallets(keys: string[]): void {
  if (keys.length === 0) {
    console.log(chalk.gray("  no keys in file"));
    return;
  }
  for (const k of keys) {
    let addr: string;
    try {
      addr = new Wallet(k).address;
    } catch {
      console.log(chalk.red("  ✗ a key in the file is not a valid private key"));
      continue;
    }
    console.log(`  ${addr.slice(0, 10)}…${addr.slice(-8)}`);
  }
}

async function status(): Promise<number> {
  const filePath = walletPath();
  const text = readWalletFilePath(filePath);
  if (text == null) {
    console.log(`${filePath} — ${chalk.yellow("absent")}`);
    return 0;
  }
  const shape = describe(text);
  const colour = shape.label === "encrypted" ? chalk.green(shape.label) : chalk.yellow(shape.label);
  console.log(`${filePath} — ${colour}${shape.detail ? ` (${shape.detail})` : ""}`);

  if (shape.label !== "encrypted") {
    showWallets(shape.keys);
    return 0;
  }
  // Report whether the keys are reachable, without ever printing one.
  const loaded = loadKeysFromFile(filePath, text, process.env.WALLETS_PASSPHRASE || null);
  if (loaded.status === "encrypted") {
    console.log(chalk.gray(`  ${loaded.keys.length} key(s) decrypt with the available passphrase`));
    showWallets(loaded.keys);
  } else if (loaded.status === "encrypted-locked") {
    console.log(chalk.gray("  encrypted — no passphrase available, keys not read"));
  } else {
    console.log(chalk.red(`  ${loaded.detail ?? "could not decrypt"}`));
  }
  return 0;
}

async function encrypt(): Promise<number> {
  const filePath = walletPath();
  const text = readWalletFilePath(filePath);
  if (text == null) {
    console.error(chalk.red(`\n❌ no wallet file at ${filePath}\n`));
    return 1;
  }
  const shape = describe(text);
  if (shape.label === "encrypted") {
    console.error(chalk.red(`\n❌ ${filePath} is already encrypted.\n`));
    return 1;
  }
  if (shape.label === "malformed") {
    console.error(chalk.red(`\n❌ ${filePath} is not readable: ${shape.detail}\n`));
    return 1;
  }

  const passphrase = await askHidden("New passphrase: ");
  if (!passphrase) {
    console.error(chalk.red("\n❌ an empty passphrase would leave the file unreadable — aborted.\n"));
    return 1;
  }
  const confirm = await askHidden("Repeat passphrase: ");
  if (confirm !== passphrase) {
    console.error(chalk.red("\n❌ passphrases do not match — aborted, file unchanged.\n"));
    return 1;
  }

  writeWalletFileAtomic(filePath, encryptWalletPayload(JSON.parse(text), passphrase));
  console.log(chalk.green(`\n✓ ${filePath} encrypted — the passphrase is not stored anywhere.`));
  console.log(chalk.gray("  Interactive runs are asked once per session; headless runs read WALLETS_PASSPHRASE."));
  return 0;
}

async function decrypt(): Promise<number> {
  const filePath = walletPath();
  const text = readWalletFilePath(filePath);
  if (text == null) {
    console.error(chalk.red(`\n❌ no wallet file at ${filePath}\n`));
    return 1;
  }
  const file = readWalletFile(text);
  if (file.kind !== "encrypted") {
    console.error(chalk.red(`\n❌ ${filePath} is ${describe(text).label}, not encrypted — nothing to do.\n`));
    return 1;
  }

  const passphrase = process.env.WALLETS_PASSPHRASE || (await askHidden(`Passphrase for ${filePath}: `));
  let inner: string;
  try {
    inner = decryptWalletText(file.envelope, passphrase);
  } catch (e: any) {
    console.error(chalk.red(`\n❌ ${e?.message ?? e}\n`));
    return 1;
  }
  writeWalletFileAtomic(filePath, inner);
  console.log(chalk.yellow(`\n✓ ${filePath} written back as plaintext.`));
  console.log(chalk.gray("  The keys are now readable by anyone who can read this file."));
  return 0;
}

const USAGE = [
  "",
  "minter wallets — manage the wallet file",
  "",
  "  wallets status      show whether the file is plaintext or encrypted",
  "  wallets encrypt     wrap the file in an scrypt + AES-256-GCM envelope",
  "  wallets decrypt     write the file back as plaintext",
  "",
  "  The file is taken from WALLETS_FILE, else wallets.json in the working",
  "  directory. The passphrase is asked once per interactive session, or read",
  "  from WALLETS_PASSPHRASE for headless runs. It is never stored or printed.",
  "",
].join("\n");

export async function runWalletCli(args: string[]): Promise<number> {
  const cmd = (args[0] || "").toLowerCase();
  if (cmd === "" || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  switch (cmd) {
    case "status":
      return status();
    case "encrypt":
      return encrypt();
    case "decrypt":
      return decrypt();
    default:
      console.error(chalk.red(`\n❌ unknown wallets command "${cmd}". Run with --help.\n`));
      return 1;
  }
}
