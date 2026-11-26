<p align="center">
  <img src="assets/minter-logo.svg" alt="Minter — on-chain mint automation" width="640">
</p>

# NFT Sniper

A command-line tool for sniping NFT mints. It targets OpenSea's SeaDrop across
five chains, and also mints **any** contract with a discoverable mint function —
ERC721/ERC1155, Manifold, Zora, Scatter, or a bespoke `mint()`.

Two ways to mint:

- **Public stages** are built entirely from on-chain data — price, fee recipient
  and per-wallet limit all come straight from the SeaDrop contract. That means
  **no OpenSea account, login, or access token**, and **no API rate limits** to
  lose a public mint to.
- **Signed / allowlist / OVR / FCFS stages** need a free OpenSea API key to fetch
  a per-wallet signed mint payload. The signing itself is done locally; the API
  only supplies the signature bytes.

Every transaction is signed and serialised **before** the stage opens, so at the
exact start time the only work left is writing bytes to the network.

Multi-wallet: paste as many keys as you like and they all fire in parallel.

---

## Requirements

- **Node.js 18 or newer** — check with `node --version`.
- A wallet with the native token of the chain you're minting on
  (ETH on Ethereum/Base/Robinhood/Soneium/Ink, USDC on Arc, BNB on Longyu).

---

## Step 1 — Install

```bash
git clone https://github.com/sammybr1m1xalt/minter.git
cd minter
npm install
npm run build
```

Then confirm the build worked:

```bash
npm start -- --help
```

<details>
<summary>Install errors</summary>

**`Could not read package.json` / `Missing script: build`**
You're in the wrong folder. Run `cd minter` first.

**`npm` or `git` is not recognised**
Install [Node.js 18+](https://nodejs.org) and [Git](https://git-scm.com/downloads),
then reopen your terminal.

</details>

---

## Step 2 — Configure (optional but recommended)

```bash
cp .env.example .env
```

Open `.env` and add a private RPC URL for the chain you'll mint on:

```
RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

A free [Alchemy](https://alchemy.com) key takes two minutes and is the single
biggest factor in whether you win a contested mint. You can also paste it at the
prompt instead — the tool works without any `.env` at all, falling back to public
nodes.

> **Never put private keys in `.env`.** You paste them into the CLI at run time.
> They're held in memory for that run only and never written to disk.

### Every `.env` key

| Key | What it does | Default |
|---|---|---|
| `RPC_URL_ETHEREUM` / `RPC_URL_BASE` / `RPC_URL_ROBINHOOD` / `RPC_URL_ARC` / `RPC_URL_SONEIUM` | Private RPC for that chain. Overrides the built-in public endpoints. | _(empty — public nodes)_ |
| `RPC_URL` | A single endpoint, used when `CHAIN` matches the chain you pick. | _(empty)_ |
| `EXTRA_RPC_URLS` | Comma-separated extra endpoints, any chain. | _(empty)_ |
| `CHAIN` | Chain highlighted in the wizard menu, and the default for the FCFS branch. **The chain you settle on is written back here**, so a mint on one chain does not leave the next run aimed at the last one. | `base` |
| `MAX_FEE_PER_GAS` | Max-fee ceiling, in gwei. Pre-filled at the prompt. | `2` |
| `MAX_PRIORITY_FEE` | Tip, in gwei. Pre-filled at the prompt. | `0.05` |
| `GAS_LIMIT` | Gas limit per mint transaction. | `250000` |
| `OPENSEA_API_KEY` | Your own OpenSea key. Optional — see below. | _(empty)_ |
| `OPENSEA_SESSION_DIR` | Where SIWE session cookies are cached. | `.minter-session/` inside the project |
| `RPC_TIMEOUT_MS` | Per-request RPC timeout. | `15000` |
| `ETHERSCAN_API_KEY` | Needed for ABI lookups on chains Sourcify doesn't cover. | _(empty)_ |
| `OPENSEA_KEY_SYNC` | Set to `0` to stop the tool mirroring its auto-minted key into `.env`. | `1` |
| `PRIVATE_KEY` | A single wallet key, for headless runs. | _(empty)_ |
| `PRIVATE_KEYS` | Comma-separated wallet keys, for headless runs. | _(empty)_ |
| `WALLETS_FILE` | Path to a JSON file of wallet keys, for headless runs. | `wallets.json` |

**Headless runs.** If `PRIVATE_KEY`, `PRIVATE_KEYS` or `WALLETS_FILE` supplies
keys, the wizard loads them instead of prompting — which is what makes an
unattended `npm start -- --fcfs <slug> --at "in 5m"` possible. Keys from the
environment are still held in memory only and never written to disk.

**You do not need an OpenSea API key.** A free key is auto-minted at runtime and
cached to disk in `.minter-cache/`, so the FCFS path works with a blank
`OPENSEA_API_KEY`. Keys older than 3 days are replaced automatically. Paste one
only if you want to manage your own.

---

## Step 3 — Run it

```bash
npm start
```

The wizard walks you through everything. Nothing is broadcast until you
explicitly confirm.

### Running it from anywhere

The package declares a `bin`, so a symlink on your `PATH` turns `minter` into a
normal command:

```bash
mkdir -p ~/.local/bin
ln -s "$PWD/dist/index.js" ~/.local/bin/minter

# only if ~/.local/bin is not on your PATH yet
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

```bash
cd ~/somewhere-else
minter --doctor
```

`npm link` does the same thing through npm instead of a hand-made symlink.

Where the config is read from stays predictable, so running it elsewhere
neither loses your keys nor scatters logs:

- `.env` — the **repo**, with a `.env` in the working directory overriding it.
- run logs — always the repo's `.minter-logs/`.
- `wallets.json` — the **working directory**, or `WALLETS_FILE`. This is the one
  exception: invoke it from the repo, or point `WALLETS_FILE` at the file, or
  pass keys through `PRIVATE_KEY` / `PRIVATE_KEYS`. Run from an unrelated
  directory with none of those set and the wizard simply has no keys to load —
  it will say so rather than minting with nothing.

### The wizard, step by step

| Step | What it wants |
|---|---|
| **1. Private keys** | Paste one per line, hidden as you type. Blank line to finish. Each key is confirmed back to you by its wallet address, so you can check you pasted the right one. |
| **2. Chain** | Ethereum, Base, Robinhood Chain, Arc, Soneium, Ink or Longyu. |
| **3. Quantity** | How many NFTs **per wallet**. Checked against the phase's real cap at step 11b. |
| **4. NFT link** | An OpenSea / Scatter / Zora / Manifold link, a collection slug, or a raw `0x` contract address. Chain aliases work too: `0xabc… on base`, `slug on arc`, `slug eth`. A contract address or item link always works with no API key. |
| **5. RPC** | Paste a full URL, or just your Alchemy key and it expands automatically. Blank uses `.env`, then public nodes. Every endpoint is checked for its chain ID — any on the wrong chain is dropped, not blasted at. |
| **6. API key + slug** | Resolves a contract address to its OpenSea slug and obtains a working API key. |
| **7. SIWE sessions** | Warms a session for **every** wallet in parallel, so no wallet is still authenticating at T-0. |
| **8. Phase discovery** | Finds every active phase on the collection. If OpenSea knows nothing about the contract, the universal adapter probes the bytecode for a mint function instead. |
| **8a. Gas** | Ceiling and tip, with the live base fee shown above the prompt. |
| **9–10. Eligibility** | Probes every wallet against every phase and prints a matrix, including how many tokens each wallet can actually mint in each phase. |
| **11. Wallet + phase** | Pick which wallets and which phase to fire. Each option shows its mintable cap. |
| **11b. Quantity check** | Compares your quantity with the selected phase's cap. Above it, you are offered the clamp; below it, you are offered the raise. Headless runs clamp silently and never raise — minting fewer than allowed is a valid choice, not an error. |
| **12. Timing** | Wait for the stage to open, or fire now if it's already live. |
| **12b. Price protection** | Optional cap — see below. |
| **14. Balances** | Shows each wallet's balance and refuses to fire if none can afford the upfront gas reservation. |
| **15. Confirm** | The summary. Type `y` to proceed. |
| **15b. Sell-after-mint** | Optionally plan an automatic sale of the minted tokens. |
| **16. Execute** | Pre-signs, holds, and fires at T-0. |
| **17. Sell** | If you opted in, sells each wallet's tokens into the best OpenSea offer. |

---

## CLI reference

| Command | What it does |
|---|---|
| `npm start` | Interactive wizard — keys, chain, quantity, NFT link, RPC, gas, timing |
| `npm start -- --help` | Print all CLI flags |
| `npm start -- --fcfs <slug\|0x…>` | FCFS/allowlist/OVR mode — multi-phase discovery, per-wallet pre-fetch, gas polling |
| `npm start -- --scatter <slug>` | Mint a Scatter.art collection — the Scatter API builds the transaction (proof + signature included) |
| `npm start -- --eligibility <slug\|0x…>` | Dry-run eligibility check — lists all active phases, whether your wallet can target each, and how many tokens it can mint |
| `npm start -- --doctor` | Read-only health report — config, wallets, key pool, SIWE sessions, and RPC latency/chain-id per chain. Exits 1 if anything will stop a run |
| `npm start -- --confirm <tx…>` | Re-ask the chain whether a transaction landed — by hash alone, so it works for a tx from an earlier run. Also `--confirm --last` / `--log <file>` / `--all` |
| `npm start -- wallet <cmd>` | `status` \| `encrypt` \| `decrypt` the wallet file (`--wallet` also works) — see [Encrypting the wallet file](#encrypting-the-wallet-file) |

### Flags

| Flag | Meaning |
|---|---|
| `--at <time>` | ISO 8601, unix seconds/ms, `"in 5m"`, `"30s"`, or `"HH:MM"` (HH:MM is read in this machine's local timezone) |
| `--when-open` | Poll the chain and fire the moment the stage opens |
| `--max-price <price>` | Max total price in ETH, `"free"`, `"0.05/unit"`, `"0.05total"`, or `"any"` (no cap) |
| `--wallets <spec>` | `all` \| `N` \| `1,3,4` — 1-based. An unknown spec, an out-of-range index, a duplicate or `0` is **refused** naming the problem, not clamped or silently narrowed. Indices are applied in wallet order however you type them |
| `--chain <key>` | `ethereum` \| `base` \| `robinhood` \| `arc` \| `soneium` \| `ink` \| `longyu` |
| `--quantity <n>` | NFTs per wallet (default 1) |
| `--doctor` | Health report: config, wallets, key pool, sessions, RPC per chain (read-only, exits 1 on a blocker) |
| `--logger [file]` | Read a run log as a digest — newest, a file, or `-` for stdin |
| `--confirm <tx…>` | On-chain receipt audit for transactions already sent. Verdicts are SUCCESS, REVERTED, PENDING, NOT_FOUND or TIMEOUT; a hash that is not `0x` + 64 hex is refused rather than sent to the RPC |

A target may also be given positionally (`npm start -- <target>`) when it is not
passed to `--fcfs`.

```bash
npm start -- --fcfs de-bots
npm start -- --fcfs de-bots --at "in 5m" --max-price 0.01
npm start -- --eligibility 0x8d80efb61341e4b8459fbb52b213d5c25a1af179
npm start -- --doctor
npm start -- --logger
npm start -- --confirm 0xabc… 0xdef…
npm start -- --confirm --last
npm start -- --fcfs 0xabc… on base --quantity 3 --wallets all
npm start -- --scatter nockmilio --chain base --quantity 2
```

---

## Understanding gas

Three different numbers, and mixing them up is the most common way to lose a mint:

| Term | What it is | Who sets it |
|---|---|---|
| **Base fee** | The network's price. Burned. | The chain |
| **Priority fee** (tip) | Paid on top, to the block producer | You |
| **Max fee** | The ceiling you'll tolerate | You |

**You pay base fee + tip.** The max fee is only a cap — if the base fee is
0.006 gwei and your tip is 0.05, you pay 0.056 gwei no matter whether your
ceiling is 2 or 200.

**But the ceiling is not free.** Before a node will even accept your transaction,
it checks that your wallet holds `gasLimit × maxFee + mint price`. So a high
ceiling with a thin wallet gets rejected outright, even though the real cost is
tiny. The tool checks this before firing and tells you the highest ceiling your
balance can support.

A SeaDrop mint uses roughly **135,000 gas** for quantity 1.

---

## Sell-after-mint

Optional, offered at step 15b. After a successful mint, the tool sells the minted
tokens into the best OpenSea offer automatically.

**The design, and why it's shaped that way:**

- **The plan is made before the mint, and reads no offers.** An offer book read
  now is stale by T-0. Only the gas cost is quoted, for all three gas modes, and
  a per-token cost floor is shown: `mint unit price + estimated sell gas`.
- **Offers are re-read after the mint, per wallet, before every single token.**
- **A sale never happens below cost.** Net proceeds per token must exceed the
  cost floor, or the token is skipped. The guard is applied twice — once on the
  listing order and again on the full fulfillment order.
- **Wallets are sold sequentially, in order.** Parallel wallets race into the
  same criteria offer; `remaining_quantity` means one fills and the others revert.
- **A failed mint sells nothing.** No sale and no token approval is sent for a
  wallet whose mint did not succeed.
- **A failed approval stops the sale.** The fulfillment pulls the NFT through
  the order's own conduit, so the approval target is resolved first and the sale
  is skipped if it cannot be — broadcasting anyway can only revert and burn gas.
- **A book that could not be read is not an empty book.** A 401, a 5xx or a
  timed-out offer read is reported as a read failure; only a successful read with
  no rows reads as "no offer clears the cost floor".
- **The full fulfillment order sets the net, for every entrypoint.**
  `fulfillOrder` names one order (`order`), the `match*` entrypoints name a list
  (`orders`); both are read, so the authoritative net re-derivation and the
  conduit lookup work for a single-order sale too.

Gas modes are rational multipliers of the live base fee and tip:
`slow` = 1.1×base + 1×tip, `fast` = 1.5×base + 2×tip, `ultra` = 2×base + 4×tip.

**Not yet verified live:** the broadcast path. Selling needs a funded wallet
holding a freshly minted token with a live offer, so the sign-and-send leg has
never run against the real chain. Everything up to and including the encoded
transaction is verified against the live API, and the decision logic
(offer ranking, cost guard, approval gate, conduit resolution, receipt verdict)
is exercised against a scripted chain and API.

---

## Supported chains

| Chain | Chain ID | Native token | Explorer |
|---|---|---|---|
| Ethereum | 1 | ETH | etherscan.io |
| Base | 8453 | ETH | basescan.org |
| Robinhood Chain | 4663 | ETH | robinhoodchain.blockscout.com |
| Arc | 5042 | USDC | explorer.arc.io |
| Soneium | 1868 | ETH | soneium.blockscout.com |
| Ink | 57073 | ETH | explorer.inkonchain.com |
| Longyu | 668800 | BNB | explorer.longyu.network |

Longyu was verified live (`eth_chainId` = `0xa3480`, explorer HTTP 200). OpenSea's
live `/api/v2/chains` does not list it, so OpenSea stage/payload flows are NOT
available there; RPC, explorer links and generic contract probing are.

---

## Adding a chain

Everything chain-specific lives in [`src/chains.ts`](src/chains.ts), so a new
network is normally one entry plus one mapping. There is no chain logic scattered
elsewhere.

### 1. Add the profile to `CHAINS`

```ts
{
  key: "mychain",            // must match the OpenSea GQL `chain` field, the
                             // `--chain` value, and the `CHAIN` env value
  chainId: 12345,
  name: "My Chain",
  explorer: "https://explorer.mychain.io",   // NO trailing slash
  nativeSymbol: "ETH",       // used for display and the sell cost floor
  rpc: {
    alchemyHost: "mychain-mainnet.g.alchemy.com",  // documentation only
    public: [
      "https://rpc.mychain.io",
      // A send-only endpoint (rejects eth_chainId/eth_call) is kept for
      // blasting and never read from — mark it with a comment.
    ],
  },
},
```

### 2. Add it to `OS_CHAIN` if OpenSea spells it differently

`OS_CHAIN` maps your internal key to OpenSea's chain identifier. Most chains are
identity mappings and can be omitted; add one only when they differ (for example
`"zora-network": "zora"`). Unknown keys pass through unchanged.

### 3. Add `RPC_URL_<KEY>` to `.env.example`

Uppercase the key: `RPC_URL_MYCHAIN=`. Add it to your own `.env` too.

### 4. Add currency sentinels to the site scanner (optional)

[`src/site-scanner.ts`](src/site-scanner.ts) keeps per-chain currency addresses in
`NATIVE_TOKEN_SENTINELS` and `WRAPPED_NATIVE_TOKENS`, so a marketplace's own
currency address is never mistaken for a collection contract. Add an entry if
your chain's native token has a contract of its own (as Arc's USDC does) or if it
has a wrapped native token.

### 5. What the site scanner looks at

- **The shell HTML**, including `data-api` / `data-endpoint` / `<form action>`
  paths, not just bundle text.
- **Every script and chunk**, breadth-first. Literal paths (`import()`,
  `new URL(..., import.meta.url)`, quoted assets) and webpack's numeric ids —
  the latter resolved through the runtime's own filename function. The two
  halves live in different files (`.u` in the runtime chunk, `.e(480)` in the
  entry chunk), so that resolution needs two passes.
- **Embedded base64 JSON** — `data:application/json;base64,…` is decoded first;
  base64 never contains the characters of an address.
- **API endpoints**, including absolute and protocol-relative URLs, re-anchored
  at the app root derived from the page URL *and* from the page's own links.

### 6. How candidates are ranked

Evidence is weighted: a mint control beats a strong JSON key, which beats a
contracts list, which beats frequency, which beats a script blob, which beats
bare text. Three corrections keep shared addresses from winning:

- **Currency sentinels** (native identifier, wrapped native) are excluded.
- **Shared infrastructure** — Seaport 1.1/1.5/1.6, the conduit controller,
  OpenSea's fee recipient — is *demoted*, not excluded: they are real contracts,
  so they stay on the list but cannot outrank the collection.
- **Weak parent keys** — an address inside `paymentTokens` / `pricingCurrencies`
  is a token even when its own key is the ambiguous `address`.

Separately, junk that only wears an address's shape is dropped before ranking. A
40-hex window slides over bytecode and arithmetic constants as readily as over
addresses, so bytecode prologues (`6080604052`), long single-nibble runs
(`0xffff…`, `0x8e38e38e…`) and repeated blocks are not candidates at all. A
vanity address is deliberately *not* filtered — it is indistinguishable from a
real one by shape, and the ranking already demotes what it cannot identify.

Responses are capped at 5 MB and reported as truncated rather than silently
incomplete, and the scan stops early only on a *decisive* signal — a strong body
that names something which is not platform infrastructure.

### Things that will not work automatically

- **OpenSea must list the chain.** Check `GET /api/v2/chains`. If OpenSea does
  not serve drops there, the FCFS path has nothing to fetch. Adding the chain
  locally does not make OpenSea support it.
- **The SeaDrop singleton must be deployed.** Public mints read price, fee
  recipient and per-wallet limit from the contract itself; if the canonical
  SeaDrop address has no code on your chain, there is nothing to read.
- **ABI lookups.** Sourcify is tried first (no key, covers most verified
  contracts) and Etherscan V2 second (needs `ETHERSCAN_API_KEY`). Sourcify uses
  the chain ID directly in its URL, so it needs no per-chain map. Etherscan V2
  does not support every chain — Soneium (1868) is one it rejects.
- **Explorer links** fall back to Basescan for unknown chains rather than
  breaking, so a missing entry degrades gracefully but points at the wrong site.

### Verifying a new chain before you rely on it

```bash
# Does OpenSea list it?
curl -H "X-API-KEY: $OPENSEA_API_KEY" https://api.opensea.io/api/v2/chains

# Is the canonical SeaDrop singleton deployed?
#   SeaDrop: 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5
cast code 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5 --rpc-url <your-rpc>

# Do the public endpoints answer eth_chainId?
curl -X POST <your-rpc> -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

---

## Architecture

50 TypeScript modules, ~25k lines. The important ones:

| Module | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | CLI entry — flag parsing, the three branches, provider cleanup |
| [`src/chains.ts`](src/chains.ts) | Chain registry and OpenSea chain mapping |
| [`src/wizard.ts`](src/wizard.ts) | Interactive wizard (steps 1–17) |
| [`src/wizard-fcfs-new.ts`](src/wizard-fcfs-new.ts) | `--fcfs` branch and `--eligibility` |
| [`src/wizard-helpers.ts`](src/wizard-helpers.ts) | Gas prompt, balances, confirm, timing, sell plan/execution |
| [`src/fcfs-mint.ts`](src/fcfs-mint.ts) | The T-0 fire coordinator for signed phases |
| [`src/fcfs-drops.ts`](src/fcfs-drops.ts) | Drop/phase discovery across GQL, REST and on-chain |
| [`src/local-mint.ts`](src/local-mint.ts) | Public-mint snipe — builds calldata on-chain, no OpenSea |
| [`src/universal-mint.ts`](src/universal-mint.ts) | Mint adapter for non-SeaDrop contracts — tries SeaDrop, generic registry, then ABI |
| [`src/abi-mint.ts`](src/abi-mint.ts) | ABI fetching (Sourcify, then Etherscan V2) |
| [`src/mint-generic.ts`](src/mint-generic.ts) | Generic calldata builder for discovered mint functions — includes the pre-mint contract screen |
| [`src/target-resolver.ts`](src/target-resolver.ts) | Turns a link/slug/address into a chain + contract |
| [`src/site-scanner.ts`](src/site-scanner.ts) | Generic any-site scanner — finds a site's API calls and contract addresses |
| [`src/contract-verify.ts`](src/contract-verify.ts) | The gate that makes the scanner safe — checks a candidate really is a contract |
| [`src/sell-after-mint.ts`](src/sell-after-mint.ts) | Offer ranking, net-proceeds guard, Seaport calldata, sale orchestration |
| [`src/seaport-abi.ts`](src/seaport-abi.ts) | Verified Seaport 1.5 / 1.6 ABIs (from Sourcify) |
| [`src/opensea-key.ts`](src/opensea-key.ts) | API key pool — lazy probe, state-based retirement, budget gate |
| [`src/opensea-session.ts`](src/opensea-session.ts) | SIWE session cookies per wallet, plus the scoped-PAT → wallet-JWT exchange |
| [`src/session-store.ts`](src/session-store.ts) | Single source of truth for the on-disk session paths |
| [`src/opensea-gql.ts`](src/opensea-gql.ts) | GraphQL queries and response parsing |
| [`src/connection-warmer.ts`](src/connection-warmer.ts) | Parallel RPC latency ranking — orders endpoints fastest-first for the blast |
| [`src/rpc-resolver.ts`](src/rpc-resolver.ts) | Endpoint discovery, chain-ID verification, blast-set planning |
| [`src/rpc-blast.ts`](src/rpc-blast.ts) | Latency-ranked blast — fires at the fastest endpoints first, escalates to the rest only if none accepts |
| [`src/auto-gas.ts`](src/auto-gas.ts) | Gas estimation with a hard timeout |
| [`src/mint-cap.ts`](src/mint-cap.ts) | Per-wallet cap arithmetic — how many tokens a wallet may mint in a phase |
| [`src/deadline.ts`](src/deadline.ts) | `withDeadline` / `withDeadlineOrThrow` — the RPC timeout backstop |
| [`src/rpc-timeout.ts`](src/rpc-timeout.ts) | `withRpcTimeout` — bounds a single chain read so a dead endpoint cannot stall a mint |
| [`src/simulate.ts`](src/simulate.ts) | Pre-flight eth_call simulation |
| [`src/allowlist-onchain.ts`](src/allowlist-onchain.ts) | Reading allowlist state from chain |
| [`src/scatter.ts`](src/scatter.ts) | Scatter.art collections, mint lists and calldata |
| [`src/scatter-mint.ts`](src/scatter-mint.ts) | Scatter mint execution — list selection, unit conversion, caps, ERC20 approval, `--scatter` |
| [`src/price-protection.ts`](src/price-protection.ts) | Price-cap parsing and enforcement |
| [`src/logger.ts`](src/logger.ts) | Per-run log files in `.minter-logs/` |
| [`src/doctor.ts`](src/doctor.ts) | `--doctor` — one read-only health report: config, wallets, key pool, sessions, RPC per chain |
| [`src/confirm-cli.ts`](src/confirm-cli.ts) | `--confirm` — re-ask the chain about transactions already sent, by hash alone |
| [`src/rpc-health.ts`](src/rpc-health.ts) | The on-chain confirmation sweep behind `--confirm` and the pre-sell re-check |

### The two mint paths

**Public phase** — `local-mint.ts`. Price, fee recipient and per-wallet limit are
read from the SeaDrop contract on-chain. Calldata is built locally. No OpenSea
credential is involved at any point.

**Signed phase** — `fcfs-mint.ts`. OpenSea returns a per-wallet
`mintSignature` + `mintData` pair; the transaction is assembled and signed
locally. A free API key is auto-minted if you don't supply one.

**Universal fallback** — `universal-mint.ts` + `mint-generic.ts`. If OpenSea knows
nothing about the contract, the bytecode is probed for a known mint selector
(ERC721/ERC1155, Manifold, Zora, Scatter, bespoke) and calldata is built from the
verified ABI.

**Which contract gets minted.** OpenSea can name two different contracts for one
drop: the collection record and the drop record. The collection pointer goes
stale — on `lagrange-bend-by-jiwa` the collection record named a 90-byte proxy
with no drop, while the drop's own `contract_address` named the contract that
actually holds it. The drop's contract wins, and the mismatch is printed rather
than applied silently (`contract_reconciled` in the run log). Both a bare
contract address and a slug go through this check, because a slug resolves
through the same collection metadata.

Before any calldata is built, the generic path **screens the contract**
(`screenMintContract` in `mint-generic.ts`). This is the only adapter that mints
into a contract we did not positively identify, so it is the only one that needs
to ask what the contract is:

- **refuse** — no bytecode (an EOA), an EIP-7702 delegated EOA, or a contract
  that answers ERC165 and claims no NFT standard. These are definite answers
  from the chain, not suspicions.
- **unknown** — the contract could not be read. An unanswered probe is not
  evidence of safety, so this blocks exactly like a refusal.
- **warn** — a live contract with privileges the deployer keeps: an owner that
  can still change the price or pause the sale, a paused mint, an exhausted
  supply, an upgradeable implementation slot. The wizard prints these **before**
  the confirmation prompt.

Warnings never silently become part of the transaction. A contract that only
warns is mintable; one that refuses or cannot be read is not.

### Signed payload: GraphQL and REST, raced when REST can serve the stage

The signed phase asks GraphQL (`MintActionTimelineQuery`) for the per-wallet
`{to, data, value}`.

When the run holds a wallet JWT, GraphQL and `POST /api/v2/drops/{slug}/mint` are
probed **together**, and the first payload to arrive wins. Sequentially, a
GraphQL call that hung consumed the whole timeout before REST was attempted at
all — up to 10s of a ~30s pre-poll window, and again at T-0. Racing costs one
extra REST call per wallet in the case GraphQL would have succeeded anyway.

The race is gated on the JWT: REST needs it for a signed/presale stage, so
without one the extra call is guaranteed to fail for exactly the stages it exists
to rescue. Public stages keep the sequential path, because the on-chain builder
already mints them with no OpenSea call at all. If both surfaces come back empty
the wait ends at the caller's timeout rather than hanging.

That endpoint is wallet-scoped too, so it needs the same wallet JWT; the JWT is
forwarded from the session the run already holds. A refusal is logged with its
status and OpenSea's error code:

    REST mint gloombles: 409 — NOT_MINTING

Every caller collapses a non-200 to "no payload", so without that line a refused
fallback was indistinguishable from the fallback never running.

### Eligibility: GraphQL first, REST as fallback

Eligibility is wallet-scoped. The primary path is the GraphQL `DropEligibilityQuery`
with the per-wallet SIWE cookie; when that fails, the code falls back to
`GET /api/v2/drops/{slug}/eligibility`.

The REST endpoint needs a **wallet JWT**, which the SIWE cookie is not — it
answers `401` without one. The minter mints one from the session it already holds:

    SIWE session cookies
      → POST /api/v2/auth/tokens           {label, scopes:["read:eligibility"], expiresInDays}
      → POST /api/v2/auth/tokens/exchange  {subjectToken, subjectTokenType:"ACCESS_TOKEN"}
      → Authorization: Bearer <jwt>  +  X-API-KEY

Both the PAT and the JWT are stored in the same owner-only session jar as the
cookies. The JWT is short-lived — measured at **one hour**, not the ~12 hours the
docs' credential table claims — so it is re-exchanged on demand; the PAT lasts 7
days.

The REST response's `price` is a **wei decimal string**, unlike GraphQL's ETH
float, and `mints_remaining` is OpenSea's own remainder for that wallet — which
is more accurate than the GraphQL path's reconstruction. In a live comparison
against the same wallet and stage, GraphQL reported a remainder of 180 (the stage
cap) while REST reported 166, the wallet's actual allowance.

### API key pool

The pool holds a handful of free OpenSea keys. It exists for **availability**, not
capacity: the rate-limit bucket is shared across every key on the account, so ten wallets on one key and
ten wallets on five keys spend the same. Extra keys buy redundancy (a key can be
revoked or start returning 403) and hedge against a per-key burst limit.

Three rules follow from that:

- **Probe lazily.** A verdict is trusted for 10 minutes; only the key about to be
  used is verified. A full census of the pool costs one call per key, every run,
  spent learning what one call would have told you — and probing draws on the same
  budget as minting.
- **Mint only when the pool cannot supply a key** (fewer than 3 usable), never on a
  calendar. The old trigger replaced every key once all of them passed 3 days,
  discarding keys that had just probed alive and capping the fleet at ~6.
- **Retire on evidence.** A key is dropped when a probe says `dead`, never because
  it is old. Age only makes a verdict decay in the ranking.

Before a run the tool compares the remaining budget against the run's estimated
call count (about 2 per wallet) and warns when it is short. Minting cannot fix
that — the quota is the IP's, not the key's.

### Doctor

`npm start -- --doctor` prints one health report: config presence, loaded wallets,
the OpenSea key pool (live-probing the best key), per-wallet SIWE session
validity, and every chain's RPC endpoints with latency and chain-id
verification. It exits 1 when something will stop a run.

It is read-only — it never logs in, never writes a file, and never moves funds —
so it is safe to run on a machine with no wallet. It prints no secrets: keys are
shown by name and fingerprint, endpoints by hostname only.

Two verdicts it deliberately does not give. An endpoint that does not answer is
`unknown`, not broken — a timeout or a socket failure says nothing about the
endpoint, so it stays in the blast set rather than being dropped. And a chain
where no endpoint answered with the right chain id is a warning, not a blocker:
firing is still possible, only the reads (nonce, gas, simulation) are unverified.

### Reading a run log (`--logger`)

Every run writes a complete record to `.minter-logs/run-<timestamp>-<pid>-<label>.log`
— header, run fields, every message, diagnostics, masked environment. That file is
a dump, so `--logger` renders it as a digest:

    npm start -- --logger              newest run log
    npm start -- --logger <file>       a specific log
    npm start -- --logger -            read stdin (pipe a run's output)

It prints the run fields, every warning and error in full, the diagnostics count
and the masked environment. Input that is not a run log — a piped stdout, an older
file — is digested generically: flagged lines first, then the lines grouped by the
wallets they mention, then the tail.

The events worth reading are written by `say()` in `logger.ts`, which puts one
line on the console *and* in the run log. The payload path uses it to report which
leg produced each wallet's payload (`payload via gql` / `via rest`) and, when
nothing did, which surfaces were tried — so "no payload" is never a bare verdict.

### Runs that leave no run log

The run logger attaches after flag parsing, so some invocations never produce a
run log at all: `wallet …` / `--wallet …`, `--doctor`, `--eligibility`, and any
run that aborts at a prompt. Every invocation is therefore also recorded in
`.minter-logs/invocations.log` — one `START` line with the arguments as typed
(redacted for anything key-shaped) and one `EXIT` line with the status. It only
ever grows, it is git-ignored, and `--logger` can read it like any other file.

    npm start -- --logger .minter-logs/invocations.log

### How the fire reaches the chain

Every endpoint is measured in parallel with a plain `eth_chainId` and ordered
fastest-first; one that does not answer in time is sorted last, not dropped. The
fire then sends the signed transaction to the **two quickest** endpoints first,
and escalates to the rest only if neither accepts within 350 ms.

The measurement runs during signing (public phase) or while the OpenSea payload
is fetched (signed phase), and the fire path **never waits for it**. If the
ranking has not finished — typically because one endpoint is dead and holding
the probe — every endpoint fires at once, which is the old behaviour. A slow
endpoint costs you the ordering, never the mint.

The same signed transaction goes to every endpoint. Only one can include it, so
a second wave is a re-send of an identical transaction, not a competing one; it
cannot consume the nonce twice.

Nonces are pre-read during the wait, walking every endpoint in turn on a
best-effort basis, and that value is used as-is at T-0. The old code re-read it
at T-0 and used the fresh value; that re-read measured as the slowest of the
three reads in the fire block (361-403ms against ~307ms for the simulation and
the estimate), and the nonce is the one value there that is usually stable — a
wallet that sent nothing during the wait has a stable pending nonce.

A wallet that did send something therefore broadcasts under a stale nonce. That
is recoverable, not silent: every endpoint rejects the broadcast with a nonce
error, and the repair pass re-reads the nonce and re-blasts the *same*
transaction — only the nonce and the signature over it change. Two cases are
deliberately never repaired. A non-nonce rejection (a revert, a closed stage) is
not fixed by a different nonce, and `already known` means that node already has
the tx and it is propagating, so re-blasting it under a new nonce would create a
second transaction for the same wallet.

The T-0 payload retry is fast at first and then backs off: 250ms gaps for the
first 3s (signer lag is a startup phenomenon), then the old 2s cadence. A flat
short gap would spend the whole retry window against a rate bucket shared by
every key on the account.

### Building the plan across endpoints

A public mint's calldata is built from on-chain reads, and the plan is built
during the wait so it costs nothing. The endpoints are tried in order, and the
caller's timeout is the budget for the **whole sweep**, not per endpoint — four
dead endpoints would otherwise cost four times the budget, and the plan is
needed before the fire. Each attempt is capped at a fair share of the budget so
one dead endpoint cannot consume all of it; the share has a 500 ms floor so a
slow-but-alive endpoint later in the list is not cut off.

A read that fails is reported as a failure. An empty allowed-fee-recipient list
and a failed read of that list are different answers: the first is a property of
the drop, the second is a network fault, and only the first refuses the mint.

### Scatter.art

Scatter mints through a bespoke `mint(auth, quantity, affiliate, signature)`
entrypoint, so the generic selector probe cannot see it and OpenSea has no phases
for it. Instead the Scatter API builds the transaction — proof and signature
included:

```bash
npm start -- --scatter nockmilio --chain base --quantity 2
```

The wizard picks the same path up on its own: when OpenSea reports no phases and
the slug is a Scatter collection **at the same contract address**, it mints
through Scatter rather than reporting "no mintable mechanism". The address
comparison is the guard — a slug can exist on both platforms for different
collections.

A Scatter mint list carries fields the API returns and the code reads:

| Field | Meaning |
|---|---|
| `root` | The list key (Merkle root) the contract knows it by |
| `token_price` / `decimals` | Price per mint in **whole currency units** — `"0.001"` ETH, `"1111"` NOCK at 16 decimals. Not a wei string. |
| `unit_size` | NFTs received per unit of the quantity field. Asking for 5 NFTs from a `unit_size` 5 list is one unit. |
| `wallet_limit` / `list_limit` | Caps in NFTs; `4294967295` means unlimited |
| `start_time` / `end_time` | The mint window. A closed list is refused, not minted into |

Lists are chosen native-first (an ERC20 price cannot be compared with a native
one, and native needs no approval), then cheapest within one currency. A
requested quantity above the wallet's remaining allowance is refused with the
numbers, not silently clipped.

An ERC20-priced list needs an approval before the mint: the token contract's
`allowance` is read, and if it is short the collection contract is approved for
the max amount. The spender is the contract that will actually pull the tokens —
`mintTransaction.to`, which is the collection for an ordinary mint and a batch
contract for a batch mint.

Verified live against `nockmilio` (Base) and `cashcat` (Robinhood): collection
metadata, list selection, unit and cap arithmetic, the `/mint` quote (including
that the API's `paymentValue` matches the list price), the sold-out refusal, the
closed-window refusal, and the full approve-then-mint send path against a
scripted chain.

### Per-wallet caps

Every phase has a per-wallet limit, and it is not a static fact — the drop owner
can edit a stage in the last minutes before it opens. The minter treats it as
live information:

- **The eligibility report** prints `You can mint: N` per phase, where N is the
  tighter of the phase's own limit and the running cap left after what the wallet
  has already minted. `unknown` means it could not be determined, never zero.
- **The wizard** compares your quantity against the selected phase's cap. Above
  it, you are offered the clamp; below it, you are offered the raise. A headless
  run clamps silently and never raises — minting fewer than allowed is a valid
  choice, not an error.
- **Both fire paths re-read the cap at T-0.** A public mint rebuilds and re-signs
  at the reduced quantity; a signed mint re-fetches every payload, because the
  signature binds the quantity and the old calldata is now invalid. A failed
  re-read never stops the fire — the original plan is still the best information
  available, and the on-chain revert is the backstop.

### "Stated" versus guessed

Several fields are `0` when they have a real meaning — a price of `0` is a free
mint, a cap of `0` is unlimited. So an API response that does **not** state one
used to parse as `0` and quietly become the optimistic reading: an unpriced drop
was quoted as free, an uncapped one as unlimited.

Each of those now carries a `priceKnown` / `capKnown` / `mintedKnown` flag
records whether the API actually stated the value. When it did not, the price
prints `unknown`, the quantity check is skipped rather than passed, and the
allocation check is not run — instead of a favourable guess. The on-chain reads
set the flags from what the contract actually returned.

Signed payloads carry the stage OpenSea signed for, and the fire refuses a
payload whose stage differs from the one you selected.

Only what **both** sides state is compared, in order: the stage uuid, the stage
type, the stage window, and — last — the stage index:

| Surface | uuid | type | window | index |
|---|---|---|---|---|
| GraphQL | — | ✓ (calldata selector: `mintPublic` / `mintSigned` / `mintAllowList`) | ✓ (calldata `mintParams`) | ✓ |
| REST | ✓ | ✓ | ✓ | — |
| local / assembled | ✓ | ✓ | ✓ | — |

A GraphQL payload is checked by **type and window**. The window is the
interesting one: the MintActionTimeline *response* states none, but OpenSea signs
`startTime`/`endTime` into the calldata's `mintParams`, and that is what
separates two stages of the same type. On `lagrange-bend-by-jiwa` the two
`SIGNED_PRESALE` phases are 16:00–16:10 and 16:10–16:15 — a type-only check could
not tell them apart, a window check can.

The **index** is a last resort, consulted only when the window is missing on a
side and cannot arbitrate. Both sides stating an index is not the same as the two
numberings agreeing: on `lagrange-bend-by-jiwa` the public stage is `stageIndex` 0
while sitting at array position 2, so the API's numbering is demonstrably not the
array's, and the signed `dropStageIndex` has never been confirmed to match it
(confirming that needs a live presale). Refusing on the index alone could block
valid mints, which is the one direction this check must never err in.

An unrecognised type label on either side means "cannot tell" and the payload is
allowed through. Refusing on a vocabulary guess would block valid mints, which is
the one direction this check must never err in.

### When it fires

For a phase that is still in the future, the signed payload cannot exist yet, so
nothing is fetched before the wait. In the **last 30 seconds** before T-0 the
minter polls for a payload — OpenSea often signs shortly before the window —
and holds it for the fire. That window is bounded, and the wait is computed from
whatever time is actually left, so the fire lands on T-0 rather than 30 seconds
after it.

Both of those were wrong: the poll ran from the moment the run started (a
ten-minute schedule polled for nine and a half minutes) and the wait then slept
the original delay again, so a drop scheduled at T+100s fired at T+170s.

At T-0 the remaining wallets are fetched in the background and the fire is **not**
gated on them. The fire goes out the moment the first payload is in hand, with a
200ms coalescing window so wallets whose payloads arrive milliseconds apart
still leave in one blast; a wallet whose payload lands after that is blasted in a
second wave by the same code path once the first has gone out. One wallet with no
payload — ineligible, or served by a signer that is down — used to hold back
every other wallet for the full 30s retry window, losing their mints too.

Measured, two wallets with one payload 6s late: the ready wallet fired at
**T+271ms** instead of T+6s, and the late one still minted at T+6s. With both
payloads late by 300ms or by 6s, both still leave in a single blast.

### Site scan (`--scan`)

    minter --scan <url> [--timeout ms] [--no-bundles]

Fetches a page, pulls every address-shaped string out of the HTML, the inline
scripts and the linked bundles, and prints them ranked by where they were found,
with the evidence — source, JSON key, occurrence count.

Not boxed to OpenSea, and deliberately **not** ranked by volume: a contract that
has not minted yet has no volume, so that signal would be useless here. A high
score is evidence, not proof; verify the candidate on-chain before minting it.

### Hot contracts (`--hot`)

    minter --hot [--window 5m] [--chain ethereum] [--chain all]
            [--top 10] [--target N] [--new hours] [--yes]

Builds its own ranking from ranged mint logs — there is no explorer endpoint
that ranks contracts by activity. Two log shapes are scanned: ERC-721
`Transfer` with `from = 0`, and ERC-1155 `TransferSingle`/`TransferBatch` with
`from = 0`. Logs are grouped by contract and ranked by **distinct minters**,
not event count: a batch minter or an airdrop claim can produce hundreds of
events from one address. Definite ERC-20 mints are excluded from the target
list (most ERC-20s do not implement ERC-165, so detection is by `decimals()` +
`balanceOf()`, not an interface query).

Each chain is ranked **separately** — volumes across a mainnet and an L2 are
not comparable, so there is no merged top-10. Windows are `5m`, `15m`, `30m`
and `1h`; `6h` and `12h` are **refused with a reason** rather than silently
truncated. A chain whose logs cannot be read is reported as `UNKNOWN`, never
as "no hot contracts".

Cost is always labelled: `0.005 ETH`, `free`, or `unknown`. Only SeaDrop's
`getPublicDrop` is authoritative; a name-matched price getter is printed with
`guess: <getter>` attached. A failed probe never becomes `0`.

    minter --hot --window 15m --chain ink
    minter --hot --window 5m --chain ethereum --target 2 --yes
    minter --hot --window 1h --chain all --new 2

`--new <hours>` filters to contracts deployed in the last N hours using
Etherscan's `contractcreation` index. It is Ethereum-only with a free key and
refuses on other chains; an unreadable deploy time is excluded, never guessed
as "old".

With a TTY the command offers a picker. Headless runs must pass `--target N`
or they refuse — a picker that blocks a cron job is a bug. Targeting loads the
same wallet file as the wizard (encrypted files work via
`WALLETS_PASSPHRASE`), **re-runs the full pre-mint screen** on the chosen
contract, prints recipient/value/calldata source, and waits for confirmation
unless `--yes`. The scanner's output is not a safety signal: a hot contract is
where rugs live. Nothing is broadcast when the screen refuses or simulation
reverts.

SeaDrop collections are planned through the SeaDrop singleton's `mintPublic`:
calling the collection's `mintSeaDrop(minter, quantity)` from an EOA reverts
`OnlyAllowedSeaDrop`, which made a genuinely free public stage look unmintable.
The planner checks the singleton path first and simulates it from the buyer.

Etherscan V2 free serves Ethereum only; Base, Arc and Robinhood are refused
with `Free API access is not supported for this chain`, and Ink is absent from
its chainlist. Those chains are scanned through their own RPCs. Enabling the
missing networks and lifting the free-tier log cap is an Alchemy console
action, not a code change.

### Drop URI history (`--drop-uri`)

    minter --drop-uri [--from-block n] [--to-block n] [--blocks n] [--top n]

SeaDrop's `updateDropURI(string)` only emits — it stores nothing and has no
getter — so the metadata pointer exists on-chain **only as a log**. This reads
`DropURIUpdated(address indexed nftContract, string newDropURI)` from Etherscan's
ranged `getLogs` (public RPCs refused the large range), and prints the NFT
contract, block and URI.

`topic0` is computed from the real event declaration in SeaDrop's
`SeaDropErrorsAndEvents.sol`, not typed from memory. The chain stores the
pointer, not the metadata — resolve the URI separately. An unanswered scan
prints `UNKNOWN` and exits 2, never "no such event". Etherscan caps a page at
1000 results; a full page is reported as truncated rather than complete.

### Reveal scan (`--reveal-scan`)

    minter --reveal-scan <contract> [--chain ethereum] [--rpc <url>]
           [--blocks <n>] [--no-deep] [--ids 1,2,3] [--gateway <url>] [--opensea]
           [--ipfs <link>]

Answers whether a drop's token-id → artwork mapping is actually private. It
reads only public data and does not try to reach anything that is not already
world-readable.

By default it also runs **deep discovery**: it fetches the verified ABI and
calls every no-arg view getter whose name suggests a pointer — so a collection
that publishes `baseTokenURI()`, `metadataURI()` or a `metadataRenderer()`
address is no longer reported as UNKNOWN just because it has no `baseURI()`.
Address-valued getters are followed one hop. Events carrying a string payload
are decoded over `--blocks` recent blocks (default 2000), with Etherscan's
ranged `getLogs` as the Ethereum fallback. Every pointer found is printed with
its source, then resolved like any other CID. `--no-deep` restores the old
three-getter behaviour.

The checks, in order:

  1. `baseURI` trailing slash — the reveal switch. No slash means every token
     returns one placeholder and there is no per-token metadata to find.
  2. `contractURI` — often carries a metadata base or the token directory.
  3. `tokenURI(id)` sample — distinct values while `baseURI` is hidden means
     per-token metadata is already being served.
  4. IPFS/Arweave resolution — the high-value one. A CID resolving to a
     *directory* of per-token JSONs is the full mapping, published, whether or
     not the contract calls itself revealed. A CID resolving to one JSON is
     just the placeholder. Directory indexes are read as a bounded prefix
     (256KB) because a 10,000-entry index is megabytes.
  5. A bounded log sweep (`--blocks`) for `ipfs://` / `ar://` references.

Verdicts: `HIDDEN`, `PARTIAL`, `PUBLIC`, `UNKNOWN`. Exit codes are the
scanner's contract: `0` nothing leaked, `1` leaked (`PUBLIC`), `2` could not
tell. "Could not tell" must not read as clean — an unreachable RPC is not
evidence that a drop is hidden.

Every CID the scan resolves is printed with a `view:` line carrying a URL that
actually serves it, so a finding is directly openable rather than a bare
`ipfs://` string.

`--ipfs <link>` views a link without a contract — an `ipfs://` or `ar://` URL,
a bare CID, a gateway URL, or a path into a directory (`ipfs://<cid>/1` fetches
token 1's JSON, not the directory):

    minter --reveal-scan --ipfs ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq

It prints the kind (`directory`, `file`, `unfetchable`), a serving URL, the
entry count and a sample. A single file is not automatically the placeholder —
that depends on whether every id returns the same document. `unfetchable` means
no gateway answered, which is not the same as "does not exist".

### Rarity (`--rarity`)

    minter --reveal-scan <contract> --rarity [--limit n] [--top n] [--pick n]
    minter --reveal-scan --ipfs ipfs://<cid> --rarity

Turns a PUBLIC finding into a target list. It reads only the mapping the
contract already publishes — nothing new is discovered — and scores each token
as the sum over its traits of `scored / count`. Higher = rarer.

- `--limit` defaults to 100 (`0` = everything). It bounds ATTEMPTS, not
  successes: measured on BAYC, 100 attempts scored ~10 and 500 attempts scored
  ~3, because the gateways throttle a single IP. The cache is what makes a
  large table accumulative rather than a single long run.
- A collection whose `tokenURI(id)` embeds the JSON as a `data:` URI needs no
  CID at all. The reveal scan detects it, and `--rarity` scores directly from
  on-chain `tokenURI` reads with the same spread sample, coverage and refusal
  rules. It reports the source as `on-chain tokenURI` rather than a directory.
- A collection that publishes ONE metadata file instead of a directory of
  per-token files is read too: if the directory has no numeric entries, the
  single `.json` file is tried (array, `{tokens: [...]}`, or keyed by id), and
  a bare FILE CID is tried as the file itself.
  It is refused — not scored — unless at least one token carries a trait, so a
  pre-reveal placeholder file reads as no data rather than as a trait-less
  collection.
- The sample is spread across the whole id range, not a contiguous prefix — a
  prefix is a strange target set and is biased if a collection mints in trait
  order.
- Scored tokens are cached in `.minter-cache/rarity/<cid>.json`, so a throttled
  run resumes instead of refetching what it already read.
- `--top <n>` (default 20) lists the rarest; `--pick <n>` prints a ready
  `--token-id` command for the nth rarest, which is the position trigger.

Honest by construction: it prints `listed`, `attempted`, `scored`, `failed` and
`cache`, and anything under 100% coverage is labelled a lower bound. Frequencies
use the scored set as the denominator, never total supply — mixing the two would
make a partial crawl look like a complete one.

Traits are read per ERC-8495's metadata schema: `value` is REQUIRED (string or
number) and `trait_type` SHOULD be present, so an entry with a value but no name
is counted, not dropped. `display_type` decides how a value is read —
`number`, `boost_number`, `boost_percentage` are numeric, `date` is a timestamp,
and an unrecognised value is treated as absent, as the schema requires.

**`date` traits are excluded from the score.** A timestamp is usually unique per
token, so scoring it by frequency would hand every token the maximum possible
score for the wrong reason. They are listed on the token but reported as
`excluded`, not silently counted.

Entries with no usable `value`, or an unknown `display_type`, are reported on an
`ignored:` line rather than disappearing into the counts.

Rarity is a property of the metadata, not a market value.

### Listings (`--listings`, `--snipe`, `--buy`)

    minter --reveal-scan <contract> --rarity --slug <slug> --listings
    minter --reveal-scan <contract> --rarity --slug <slug> --snipe --token-id N [--yes]
    minter --snipe [contract|ipfs-link] --token-id 1,2,3 [--count 2] [--yes]
    minter --snipe [contract|ipfs-link] [--token-id N] [--slug S] [--yes]

A trailing numeric positional after `--snipe` is also read as the token id, so
`--reveal-scan <contract> --snipe 3255` is the same as adding `--token-id 3255`.
`--buy <tokenId>` is an alias for `--snipe --token-id <tokenId>`. Both forms
route to `src/snipe-cli.ts`, which owns every money-moving step. With a token
id it scrapes metadata and the listing for that id ALONE and does not build a
rarity table; with no id it runs the read-only rarity report first and asks
which reported+listed id to buy. Rarity percentile is `UNKNOWN` in the
targeted form — one token cannot establish trait frequencies.

Once the table knows which ids are rare, `--listings` asks whether they are
already listed, and for how much. The price is printed **in the rarity row**,
next to that token's score and traits — not in a separate list you have to
cross-reference by hand. `not listed` is printed as `not listed`, never as
`listed not listed`; a price whose decimals are unknown stays labelled rather
than being divided by a guessed exponent.

    GET /api/v2/listings/collection/{slug}/nfts/{tokenId}/best

A 404 with `No listings found` is a real "not listed", not an error. An
auth failure is reported as `could not read (HTTP 401 — API key rejected)` and
never collapsed into "not listed" — that misreading is the expensive one.

`--buy <tokenId>` vends the buy transaction
(`POST /api/v2/listings/fulfillment_data`), quotes gas, asks, and sends. It
loads the wallet through the wizard's own loader, so an encrypted
`wallets.json` works unchanged (`WALLETS_PASSPHRASE`, or an interactive prompt).

Prices come from ONE collection-level listing page, not one request per row,
and the cheapest order per token wins. Listed ids are added to the rarity
sample in the same pass, so a cheap listed token gets a real rarity score next
to its price instead of a bare "listed" line with no context. A `rare + listed`
table collects those rows. No OpenSea key means prices stay unknown — never
"not listed".

Multiple ids enter BATCH mode: `--token-id` is repeatable, comma-separated, or
just a row of numeric positionals. One reveal scan and one collection listing
page probe them all, the report shows each token's traits and price, and the
user is asked how many to proceed with (`--count N` for headless). The chosen
orders are re-read, then bought in ONE transaction via
`POST /api/v2/listings/cross_chain_fulfillment_data` with the exact listing
hashes and same-chain native payment. Verified live with two orders: one tx to
Seaport using `fulfillAvailableAdvancedOrders` (`0x87201b41`). A response with
more than one transaction is refused rather than half-broadcast; cross-chain
swaps need extra steps and are not sent here.
`fulfillAvailableAdvancedOrders` may skip unavailable orders (`maximumFulfilled`),
so the receipt must be checked to see how many actually filled. The spend
path now waits for a bounded receipt and reads ERC-721/ERC-1155 transfer logs
to the buyer; a mined transaction missing one of the chosen ids is reported as
`fulfillment failed`, never as a clean success. A timeout stays `timeout`.

Both snipe forms load the wallet exactly as the wizard does, re-read the
token's listing, walk RPC endpoints until one answers with the right chain id,
estimate gas with the buyer as `from`, check that the wallet covers price +
gas, fetch the Seaport buy payload, and only then ask for confirmation. No
wallet is loaded for a plain `--reveal-scan --rarity --listings` run — that
path only reports prices. Only ids actually listed on OpenSea can be bought;
in the picker form they must also be present in the reported rarity table.

The independent reads in the reveal scan (baseURI, uri, contractURI,
totalSupply and the tokenURI sample), the CID inspections, the ABI getter
probes and the event sweeps now run in bounded parallel pools. The event sweep
is skipped when the contract already stated a pointer, since events are the
fallback for a silent contract rather than a tax on every scan.

A cold directory listing probes gateways in parallel and keeps the FULL answer,
not the fastest partial one — one gateway can return a two-entry stub while
another holds eleven thousand. Rarity then uses that answering gateway first
with short per-request deadlines. Measured on `official-rebelkin`: a cold run
dropped from roughly ten minutes to under a minute. A directory listing smaller
than `totalSupply` is reported as PARTIAL, not as proof of the full mapping.

`--verify-ipfs` hashes direct-CID metadata bytes against the CID from the
contract before scoring; mismatches are dropped and counted. A path-based
`/ipfs/<directory>/<id>` URL does not expose the child CID, so those documents
report `UNKNOWN` rather than a false mismatch. The flag is off by default and
adds no requests to a normal scan.

Before gas estimation, the vended buy transaction is checked for null/invalid
addresses and bytes32 fields. A null tuple field now names itself instead of
appearing as `gas estimate failed: invalid address value=null`.
`buy transaction has no input_data.parameters — nothing was sent` meant the
fulfillment endpoint answered with a DIFFERENT Seaport shape: `fulfillAdvancedOrder`
carries `advancedOrder`, `criteriaResolvers`, `fulfillerConduitKey` and
`recipient`, with no flat `parameters`. Collections using criteria/resolvers
(such as `official-rebelkin`) hit this every time. Both shapes are encoded now;
the advanced selector is `0xe7acab24` (computed from the vended function string),
with the same trailing `0xcdb44011` attribution suffix. Conduit keys are bytes32,
not addresses. Nothing was ever sent on the refusal — it happened before gas
estimation.

Successful scan, IPFS-view and rarity+listings reports print their elapsed time
at the end, e.g. `rarity + listings report completed in 10.2s`.

An underfunded wallet is refused before send with
`insufficient ETH balance: have X, need ≈ Y (price + gas) — nothing was sent`.

`gas estimate failed: execution reverted` on a valid order was caused by calling
`eth_estimateGas` without `from`. Seaport checks `msg.sender` against the
fulfiller encoded in the order; with no `from` the node simulates the zero
address and reverts. The real send already used the wallet, so the estimate now
passes the buyer address explicitly. Verified on a live advanced order: the
same calldata estimated at 205787 gas with `from` and reverted without it.

- ERC20-priced listings are supported for single-token snipes. Live probing on
  `netnet-gear` (USDG) showed `value: "0"` with the payment token at
  `protocol_data.parameters.consideration[].token` (`itemType: 1`);
  `price.current` carries no address. The tool approves the exact base-unit
  amount to the spender derived from the vended `fulfillerConduitKey` — through
  `ConduitController.getConduit` for a non-zero key, or Seaport itself for a
  zero key — then sends the fill with zero native value. Batch ERC20 payment is
  refused until that endpoint shape is verified.
- `calldata_suffix` is **not** the selector: it is the first four bytes of
  `keccak256("api.opensea.io")` (verified: `0xcdb44011`), appended as trailing
  calldata so the fill is attributed to OpenSea. Seaport reads arguments by
  offset and ignores trailing bytes.
- OpenSea refuses burn and system addresses as payer, so the buyer is derived
  from the wallet key, not chosen.
- `--slug` overrides resolution. An address can map to several OpenSea
  collections — BAYC's contract resolves to ten, including `boredapeyachtclub`
  and `bored-ape-yacht-club-shadow` — and the resolver refuses to guess between
  them rather than silently running against the derivative.

Only OpenSea is checked. Reservoir, the aggregator that would have covered
Blur/LooksRare/X2Y2 in one call, was sunset on 2025-10-15.

`--opensea` also asks OpenSea's public token endpoint for the sampled ids and
compares the name against the on-chain `tokenURI`, which is the window where
OpenSea's index has run ahead of the contract (or lagged it). It is a report,
not a verdict: it prints the keys OpenSea actually returned and only compares
when both sides yielded a readable name. A missing or dead `OPENSEA_API_KEY` is
reported as such. Verified live against BAYC with a working key: HTTP 200 with
`traits` and `image` for in-range ids, 404 out of range. Note that OpenSea
serves `name: ""` for most ids of a collection whose name lives on the image,
so a non-empty name is not a reliable "has metadata" signal — the mode prints
traits/image presence too.

With `--rarity`, `--opensea` does NOT run that per-token metadata comparison —
it would add ~25s for three ids. Instead it reuses ONE collection listing page
and prints prices beside the rarest rows under `OpenSea — listings for the
rarest tokens`, labelled with the listing source. It adds no metadata fetches:
only `--listings` extends the crawl with extra listed ids. Measured on
`official-rebelkin`: 52.5s for `--rarity` vs 48.3s with `--opensea` (noise,
not degradation).

For a genuine OpenSea Studio drop the answer is `HIDDEN`: OpenSea holds the
files privately until the reveal, so there is nothing to read before it. The
`PUBLIC` cases are a creator who uploaded to IPFS first and only "revealed" by
repointing `baseURI`, a commit-reveal seed left on-chain, or an indexer lag
between the metadata going public and OpenSea catching up. What you do with a
`PUBLIC` finding is a supply question, not a rarity one — IDs are sequential, so
the mapping gives you a position to target.

### A mint that lands late

The receipt poll gives up after 60s, and the sell step only sells a wallet whose
mint is `SUCCESS` — so a transaction that landed after the poll was reported
`UNKNOWN` forever and its tokens were never offered.

Before the sell decision the minter re-asks the chain, by transaction hash, for
every wallet whose receipt was never read. One that did land becomes `SUCCESS`
and sells; one that is still `PENDING`, or that no endpoint can speak to, stays
`UNKNOWN` honestly. That re-check is bounded (20s) so it never becomes a second
60s-per-wallet wait.

To settle one later, or a transaction from a run that has finished:

```bash
npm start -- --confirm 0x<txhash> [<txhash> …]   # ask about these
npm start -- --confirm --last                    # every tx in the newest run log
npm start -- --confirm --log <file>              # every tx in a specific run log
npm start -- --confirm --all                     # every tx in .minter-logs/
```

It reads by hash alone, so no accepting endpoint or run state is needed. Verdicts
are SUCCESS, REVERTED, PENDING, NOT_FOUND and TIMEOUT — and TIMEOUT is not a
failure, it means the sweep could not tell.

---

## What it protects you from

Each of these is checked *before* anything is broadcast:

- **Ceiling below the base fee** — rejected by every node. Can't be entered.
- **Tip above the ceiling** — invalid under EIP-1559. Can't be entered.
- **Wallet can't cover the upfront reservation** — refuses to fire and tells you
  the ceiling you *can* afford.
- **Firing before the stage opens** — SeaDrop reverts with `NotActive` and burns
  gas. "Fire now" isn't offered when the stage opens later.
- **Wrong network** — every RPC is checked for its chain ID; any on the wrong
  chain is dropped rather than blasted at. A target that resolves to a different
  chain than the one you picked switches chains and re-resolves endpoints instead
  of silently minting on the wrong one.
- **Quantity above the per-wallet cap** — measured against the phase's real cap
  before you fire, and re-checked at T-0. A drop whose limit is edited down in
  the last minutes is adjusted for rather than broadcast to revert.
- **A stalled RPC** — every network call is bounded; ethers' own 5-minute
  `FetchRequest` default is not allowed to hold a mint hostage.
- **A mint that never confirmed** — a missing receipt is reported as `UNKNOWN`,
  not `SUCCESS`. A wallet that did not mint is never treated as having minted.

If a transaction is rejected by every endpoint, it says so plainly instead of
waiting for a receipt that will never exist.

---

## Verification scripts

The harnesses are not shipped on `main`. They live on the `test` branch in
`scripts/verify`:

    git checkout test
    cd scripts/verify && ./run-all.sh

Each script prints its own PASS/FAIL; `run.js` is the mock JSON-RPC server and
the fire-path harness. `npm run build` first. Three latency probes sit outside
the default run because they print timings rather than verdicts and need a real
endpoint: `t0-cost.js`, `rpc-floor.js`, `cold-start.js` (all take `MEASURE_RPC`).

Keep the harnesses on `test` and the shipping code on `main`; do not merge
`test` into `main` just to restore the folder.

## Security

- Private keys are pasted at run time and kept in memory. They are **never
  transmitted anywhere** except as a locally-signed transaction, and never
  printed — not to the console, not to a run log.
- The one optional at-rest store is the wallet file (`wallets.json`, or
  `WALLETS_FILE`), and it can be encrypted — see below. `.env`, `wallets/`,
  `wallets.json` (including the `.tmp-*` a write renames into place) and
  `*.key` are git-ignored. A `WALLETS_FILE` pointed somewhere else is only as
  ignored as you make it — check with `git check-ignore -v <path>`.
- Every piece of runtime state lives inside the project and is git-ignored:
  `.minter-cache/` (API key pool), `.minter-session/` (SIWE sessions) and
  `.minter-logs/` (per-run logs). All three are created automatically on first
  use — nothing to pre-create.
- Use dedicated hot wallets funded with only what you intend to spend.
- Read [`src/local-mint.ts`](src/local-mint.ts) if you want to verify exactly what
  gets signed and sent.

### Encrypting the wallet file

`npm start -- wallet encrypt` wraps the file in an authenticated envelope:
scrypt derives a key from a passphrase (2^17 × r=8, the OWASP recommendation),
and AES-256-GCM encrypts the previous contents unchanged. The plaintext format
and the encrypted one have the same shape underneath, so an old unencrypted
file keeps loading and `wallet decrypt` restores it byte-for-byte.

    npm start -- wallet status      # plaintext / encrypted / absent
    npm start -- wallet encrypt
    npm start -- wallet decrypt
```

`wallets` (plural) and `--wallet` (dashed) are both accepted. Neither is
`--wallets`, which is the mint flag that selects *which* wallets to mint with
and takes `all | N | 1,3,4`.

The file holds keys in any of these shapes — a bare array, or an object with a
`wallets` array whose entries are either strings or `{ "pk": ... }` /
`{ "privateKey": ... }`:

```json
["0xabc…", "0xdef…"]
```
```json
{ "wallets": [{ "pk": "0xabc…" }, { "privateKey": "0xdef…" }] }
```

Keys are `0x`-prefixed 32-byte hex. Duplicates are dropped by address. An entry
that is not a valid key is reported by `wallet status` rather than silently
skipped. The file is read from the working directory, or from `WALLETS_FILE`.
The passphrase is asked once per interactive session, or read from
`WALLETS_PASSPHRASE` for headless runs. It is never stored, never printed, and
never taken as a command-line flag — a flag would sit in your shell history and
in `ps` output for the life of the process.

What it buys you, stated plainly: the file is unreadable if it leaks on its own
— a backup, a stray `scp`, an accidental commit. A passphrase written in `.env`
next to the file does **not** protect against anyone who already has your home
directory. And it does not cover `PRIVATE_KEY` / `PRIVATE_KEYS` in `.env` itself
— those are read raw, so move them into an encrypted wallet file rather than
keeping both.

An encrypted file with no passphrase available is reported rather than silently
yielding zero wallets: the run log says so, `--doctor` says "wallet file is
encrypted and no passphrase is available" instead of "none loaded", and the
keys supplied through the environment still load.

---

## Known issues

None of these block a mint.

1. **`--fcfs` lists public phases as targetable.** `fetchSignedPayload` only
   returns data for signed stages, so picking a public phase in that branch ends
   at "Could not fetch signed mint data for this phase". The public phase is
   meant to be run through the wizard, not `--fcfs`.
2. **Intermittent empty discovery.** `--fcfs <slug>` has occasionally returned
   "No active phases found" and fallen back to on-chain, finding only the public
   stage, while a direct probe found more. Not reproducible since; the leading
   suspect is transient GraphQL throttling.
3. **Sell-after-mint broadcast is unverified.** See above.
4. **Soneium ABI lookups depend on Sourcify alone** — Etherscan V2 rejects chain
   ID 1868.
5. **No test suite is committed.** The test harness and page fixtures were
   removed, and no test script is defined in `package.json`. Typecheck
   (`npm run typecheck`) and build (`npm run build`) are the remaining gates.

---

## Troubleshooting

**`No usable RPC endpoint for <chain>`**
Every candidate was on the wrong chain or unreachable. Paste a working URL at the
prompt, or set `RPC_URL_<CHAIN>` in `.env`.

**`No phases found`**
OpenSea isn't hosting a drop for that contract. The wizard then tries the
universal adapter; if that also fails, the contract simply has no discoverable
mint function.

**`Account can not perform trading operations`**
The sell path needs the fulfiller to own a token covered by the offer. It's a
OpenSea-side restriction, not a bug.

**The process hangs after printing its final line**
Fixed — a provider cleanup hook now runs on every exit path. If you still see it,
upgrade; you're on an older build.

**`--at "HH:MM"` fires at the wrong time**
`HH:MM` is interpreted in the machine's local timezone, matching the times the
wizard prints. Use an explicit ISO 8601 timestamp or unix seconds for anything
else. All human-facing time reports (mint time, scheduled fire, stage open/close
windows, run-log messages) use that same local wall clock and print the zone
label; ISO strings remain only in machine-readable API payloads and caches.

---

## License

MIT
