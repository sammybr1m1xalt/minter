# NFT Mint Sniper

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
  (ETH on Ethereum/Base/Robinhood/Soneium, USDC on Arc).

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
| `CHAIN` | Chain highlighted in the wizard menu, and the default for the FCFS branch. | `base` |
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

### The wizard, step by step

| Step | What it wants |
|---|---|
| **1. Private keys** | Paste one per line, hidden as you type. Blank line to finish. Each key is confirmed back to you by its wallet address, so you can check you pasted the right one. |
| **2. Chain** | Ethereum, Base, Robinhood Chain, Arc, or Soneium. |
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
| `npm start -- --eligibility <slug\|0x…>` | Dry-run eligibility check — lists all active phases, whether your wallet can target each, and how many tokens it can mint |
| `npm start -- --doctor` | Read-only health report — config, wallets, key pool, SIWE sessions, and RPC latency/chain-id per chain. Exits 1 if anything will stop a run |

### Flags

| Flag | Meaning |
|---|---|
| `--at <time>` | ISO 8601, unix seconds/ms, `"in 5m"`, `"30s"`, or `"HH:MM"` (HH:MM is read in IST, matching the times the wizard prints) |
| `--when-open` | Poll the chain and fire the moment the stage opens |
| `--max-price <price>` | Max total price in ETH, `"free"`, `"0.05/unit"`, `"0.05total"`, or `"any"` (no cap) |
| `--wallets <spec>` | `all` \| `N` \| `1,3,4` — default is the single primary wallet |
| `--chain <key>` | `ethereum` \| `base` \| `robinhood` \| `arc` \| `soneium` |
| `--quantity <n>` | NFTs per wallet (default 1) |

A target may also be given positionally (`npm start -- <target>`) when it is not
passed to `--fcfs`.

```bash
npm start -- --fcfs de-bots
npm start -- --fcfs de-bots --at "in 5m" --max-price 0.01
npm start -- --eligibility 0x8d80efb61341e4b8459fbb52b213d5c25a1af179
npm start -- --doctor
npm start -- --fcfs 0xabc… on base --quantity 3 --wallets all
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

Gas modes are rational multipliers of the live base fee and tip:
`slow` = 1.1×base + 1×tip, `fast` = 1.5×base + 2×tip, `ultra` = 2×base + 4×tip.

**Not yet verified:** the broadcast path. Selling needs a funded wallet holding a
freshly minted token with a live offer, so the sign-and-send leg has never been
executed. Everything up to and including the encoded transaction is verified
against the live API.

---

## Supported chains

| Chain | Chain ID | Native token | Explorer |
|---|---|---|---|
| Ethereum | 1 | ETH | etherscan.io |
| Base | 8453 | ETH | basescan.org |
| Robinhood Chain | 4663 | ETH | robinhoodchain.blockscout.com |
| Arc | 5042 | USDC | explorer.arc.io |
| Soneium | 1868 | ETH | soneium.blockscout.com |

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

### 5. Site-scanner regression fixtures

The scanner's ranking is where a silent bug is most expensive: a scoring change
returns the wrong contract and nothing looks wrong. `fixtures/scanner/` holds
saved inputs — a real OpenSea collection page and its API payload, a real
webpack 5.94 build, a real SPA shell — plus small synthetic cases for individual
rules (sentinel exclusion, key strength, nesting depth, chunk paths, API-path
discovery). `npm run test:scanner` checks them.

No test framework is involved: the runner states an expectation per case and
reports which failed. One case starts a local HTTP server to pin behaviour that
only exists across requests — that the API scan does **not** stop at the first
endpoint that answers. Stopping there lets a shared contract (a marketplace, a
payment router) end the scan before the collection itself is fetched, and
ranking cannot recover from data it never saw.

Chunk discovery covers both mechanisms: string literals (`import("./x.js")`,
`new URL("./x.js", import.meta.url)`, quoted asset paths) and webpack's numeric
ids, which are resolved through the runtime's own filename function. The two
halves live in different files — the `.u` function in the runtime chunk, the
`.e(480)` calls in the entry chunk — so that resolution needs two passes.

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

43 TypeScript modules, ~25k lines. The important ones:

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
| [`src/scatter.ts`](src/scatter.ts) | Scatter.art collections and mint calldata |
| [`src/price-protection.ts`](src/price-protection.ts) | Price-cap parsing and enforcement |
| [`src/logger.ts`](src/logger.ts) | Per-run log files in `.minter-logs/` |
| [`src/doctor.ts`](src/doctor.ts) | `--doctor` — one read-only health report: config, wallets, key pool, sessions, RPC per chain |

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
capacity: the rate-limit budget belongs to the IP, so ten wallets on one key and
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

### How the fire reaches the chain

Every endpoint is measured in parallel with a plain `eth_chainId` and ordered
fastest-first; one that does not answer in time is sorted last, not dropped. The
fire then sends the signed transaction to the **two quickest** endpoints first,
and escalates to the rest only if neither accepts within 600 ms.

The measurement runs during signing (public phase) or while the OpenSea payload
is fetched (signed phase), and the fire path **never waits for it**. If the
ranking has not finished — typically because one endpoint is dead and holding
the probe — every endpoint fires at once, which is the old behaviour. A slow
endpoint costs you the ordering, never the mint.

The same signed transaction goes to every endpoint. Only one can include it, so
a second wave is a re-send of an identical transaction, not a competing one; it
cannot consume the nonce twice. Nonces are re-read after the wait, and only the
wallets whose nonce actually moved are re-signed.

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

## Security

- Private keys are pasted at run time, kept in memory, and **never written to
  disk or transmitted anywhere** except as a locally-signed transaction.
- `.env`, `wallets/` and `*.key` are all git-ignored.
- Every piece of runtime state lives inside the project and is git-ignored:
  `.minter-cache/` (API key pool), `.minter-session/` (SIWE sessions) and
  `.minter-logs/` (per-run logs). All three are created automatically on first
  use — nothing to pre-create.
- Use dedicated hot wallets funded with only what you intend to spend.
- Read [`src/local-mint.ts`](src/local-mint.ts) if you want to verify exactly what
  gets signed and sent.

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
5. **No test suite is committed.** The test harness and fixtures were removed;
   `npm test` is no longer defined in `package.json`. Typecheck
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
`HH:MM` is interpreted in IST, matching the times the wizard prints. Use an
explicit ISO 8601 timestamp or unix seconds for anything else.

---

## License

MIT
