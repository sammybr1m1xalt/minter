// `--hot` must decrypt through the SAME passphrase source the wizard uses:
// the interactive prompt sets wizard's session passphrase, not just the env var.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");
const W = require("/home/anon/minter/dist/wallet-file.js");

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`);
  }
};

// The wizard caches the session passphrase in module state. Each case needs a
// fresh module instance so "asked once per session" doesn't leak across cases.
function fresh() {
  for (const m of ["prompt", "wizard", "hot-cli"]) {
    delete require.cache[require.resolve("/home/anon/minter/dist/" + m + ".js")];
  }
  return {
    P: require("/home/anon/minter/dist/prompt.js"),
    H: require("/home/anon/minter/dist/hot-cli.js"),
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hot-wallet-"));
  const file = path.join(dir, "wallets.json");
  const pk = "0x" + "42".repeat(32); // throwaway key, never funded
  const expected = new Wallet(pk).address;
  const PASS = "suite-passphrase";

  const oldFile = process.env.WALLETS_FILE;
  const oldPass = process.env.WALLETS_PASSPHRASE;
  try {
    fs.writeFileSync(file, W.encryptWalletPayload([pk], PASS), { mode: 0o600 });
    process.env.WALLETS_FILE = file;

    // 1. The user TYPES the passphrase (nothing in the environment).
    {
      delete process.env.WALLETS_PASSPHRASE;
      const { P, H } = fresh();
      let prompts = 0;
      P.askHidden = async () => {
        prompts++;
        return PASS;
      };
      const loaded = await H.loadFirstWalletKey();
      ok(
        "interactively entered passphrase decrypts in --hot",
        !!loaded && loaded.address === expected && loaded.key.toLowerCase() === pk.toLowerCase(),
        loaded ? loaded.address : "<null>"
      );
      ok("the interactive prompt was actually used", prompts === 1, String(prompts));
    }

    // 2. A wrong passphrase, fresh session, yields no key.
    {
      process.env.WALLETS_PASSPHRASE = "definitely-wrong";
      const { H } = fresh();
      const refused = await H.loadFirstWalletKey();
      ok("a wrong passphrase yields no key", refused === null);
    }

    // 3. A headless run with the correct env passphrase still works.
    {
      process.env.WALLETS_PASSPHRASE = PASS;
      const { P, H } = fresh();
      P.askHidden = async () => {
        throw new Error("must not prompt when the env var is set");
      };
      const viaEnv = await H.loadFirstWalletKey();
      ok("env passphrase still works without prompting", !!viaEnv && viaEnv.address === expected);
    }
  } finally {
    if (oldFile === undefined) delete process.env.WALLETS_FILE;
    else process.env.WALLETS_FILE = oldFile;
    if (oldPass === undefined) delete process.env.WALLETS_PASSPHRASE;
    else process.env.WALLETS_PASSPHRASE = oldPass;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
