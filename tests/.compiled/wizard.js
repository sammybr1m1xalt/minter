"use strict";
// Interactive universal mint wizard — handles ALL mint types from one entry:
// allowlisted phases (signed payload), public phases (on-chain), OVR, token-gated.
//
// Flow:
//   1. Load wallet keys
//   2. Resolve NFT target (OpenSea link / slug / contract address)
//   3. Warm SIWE sessions for ALL loaded wallets in parallel
//   4. Discover ALL phases (OpenSea REST/GraphQL + on-chain SeaDrop fallback)
//   5. Probe eligibility for EACH wallet against EACH phase
//   6. Report a per-wallet × per-phase eligibility matrix
//   7. Prompt user: pick which wallet + which phase to use (or auto-select)
//   8. Route to public (on-chain) or signed (OpenSea) mint execution
//
// Nothing is written to disk: pasted keys live in memory for the run only.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEligibilityCheck = exports.runFcfsBranchCli = exports.runFcfsBranch = void 0;
exports.runWizard = runWizard;
exports.loadEnvKeys = loadEnvKeys;
exports.selectFromLoaded = selectFromLoaded;
const chalk_1 = __importDefault(require("chalk"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
// Load .env so process.env has RPC_URL_*, OPENSEA_API_KEY, etc.
// Must happen before any imported module reads process.env.
// Resolve relative to THIS file's directory (dist/), not CWD — user may run
// `minter` from anywhere and the .env lives next to the project.
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, "..", ".env") });
const ethers_1 = require("ethers");
const chains_1 = require("./chains");
const slug_resolver_1 = require("./slug-resolver");
const rpc_resolver_1 = require("./rpc-resolver");
const rpc_blast_1 = require("./rpc-blast");
const fcfs_drops_1 = require("./fcfs-drops");
const seadrop_onchain_1 = require("./seadrop-onchain");
const seadrop_public_1 = require("./seadrop-public");
const local_mint_1 = require("./local-mint");
const prompt_1 = require("./prompt");
const wizard_helpers_1 = require("./wizard-helpers");
const opensea_key_1 = require("./opensea-key");
const opensea_session_1 = require("./opensea-session");
const target_resolver_1 = require("./target-resolver");
const schedule_1 = require("./schedule");
const price_protection_1 = require("./price-protection");
const universal_mint_1 = require("./universal-mint");
const simulate_1 = require("./simulate");
const rpc_blast_2 = require("./rpc-blast");
const opensea_gql_1 = require("./opensea-gql");
const fcfs_mint_1 = require("./fcfs-mint");
var wizard_fcfs_new_1 = require("./wizard-fcfs-new");
Object.defineProperty(exports, "runFcfsBranch", { enumerable: true, get: function () { return wizard_fcfs_new_1.runFcfsBranch; } });
Object.defineProperty(exports, "runFcfsBranchCli", { enumerable: true, get: function () { return wizard_fcfs_new_1.runFcfsBranchCli; } });
Object.defineProperty(exports, "runEligibilityCheck", { enumerable: true, get: function () { return wizard_fcfs_new_1.runEligibilityCheck; } });
async function runWizard(log, opts = {}) {
    log.info("Wizard: started");
    log.field("startup_mode", "interactive");
    log.field("chain_env", process.env.CHAIN || "<unset>");
    log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
    log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");
    if (opts.at)
        log.field("scheduled_at", String((0, schedule_1.parseWhen)(opts.at)));
    if (opts.maxPrice)
        log.field("max_price", opts.maxPrice);
    printBanner();
    // ── 1. Private keys ───────────────────────────────────────────────────
    log.info("Wizard: prompting for keys");
    const walletKeys = await promptKeys(log, opts.wallets);
    log.field("wallet_count", walletKeys.length);
    if (walletKeys.length === 0) {
        throw new Error("No wallet keys provided.");
    }
    const wallets = walletKeys.map((k) => new ethers_1.Wallet(k));
    // ── 2. Chain ──────────────────────────────────────────────────────────
    let chainKey = opts.chain
        ? (0, target_resolver_1.chainSlug)(opts.chain)
        : await (0, prompt_1.askChoice)("Which chain?", chains_1.CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })), Math.max(0, chains_1.CHAINS.findIndex((c) => c.key === (process.env.CHAIN || "base").toLowerCase())));
    if (!(0, chains_1.resolveChain)(chainKey)) {
        throw new Error(`Unknown chain "${chainKey}". Use ethereum, base, polygon, arbitrum, optimism, zora-network, or robinhood.`);
    }
    log.field("chain", chainKey);
    const chainProfile = (0, chains_1.resolveChain)(chainKey);
    // ── 3. Quantity ───────────────────────────────────────────────────────
    const quantity = opts.quantity ?? (await promptQuantity(walletKeys.length));
    log.field("quantity", quantity);
    if (quantity <= 0) {
        throw new Error("Quantity must be at least 1. Aborting.");
    }
    // ── 4. NFT target ──────────────────────────────────────────────────────
    const target = opts.target
        ? await promptTarget(log, chainKey, opts.target)
        : await promptTarget(log, chainKey);
    const nftInput = target.contract;
    chainKey = target.chainKey;
    log.field("nft_input", nftInput);
    log.field("label", target.label);
    log.field("platform", target.resolved?.platform ?? "unknown");
    // ── 5. RPC endpoints ──────────────────────────────────────────────────
    const manualRpcs = await promptRpc(chainProfile);
    if (manualRpcs.length === 0) {
        throw new Error(`No RPC endpoints for ${chainProfile.name}. Set RPC_URL_${chainProfile.key.toUpperCase()} in .env, or pass one interactively.`);
    }
    const { urls: candidateRpcs, source } = (0, rpc_resolver_1.resolveRpcsForChain)(chainKey, manualRpcs);
    console.log(chalk_1.default.gray(`  Source: ${source}`));
    console.log(chalk_1.default.gray(`  Checking ${candidateRpcs.length} endpoint(s)...`));
    const plan = await (0, rpc_resolver_1.planRpcs)(candidateRpcs, chainProfile.chainId);
    for (const bad of plan.dropped) {
        const wrong = (0, chains_1.resolveChain)(bad.chainId);
        console.log(chalk_1.default.red(`    ✗ ${labelOf(bad.url)} is chain ${bad.chainId}${wrong ? ` (${wrong.name})` : ""} — dropped`));
    }
    for (const ep of (0, rpc_blast_1.parseRpcEndpoints)(plan.urls)) {
        const failure = plan.failures.find((f) => f.url === ep.url);
        if (failure) {
            const benign = /not allowed|does not exist|not supported|method not found/i.test(failure.message);
            console.log(benign
                ? chalk_1.default.gray(`    • ${ep.label}  (send-only)`)
                : chalk_1.default.yellow(`    ⚠ ${ep.label}  ${failure.message.slice(0, 90)}`));
        }
        else {
            console.log(chalk_1.default.green(`    ✓ ${ep.label}`));
        }
    }
    if (plan.urls.length === 0) {
        throw new Error(`No usable RPC endpoint for ${chainProfile.name}`);
    }
    if (!plan.verified) {
        console.log(chalk_1.default.yellow(`  ⚠ No endpoint confirmed chain id ${chainProfile.chainId}.`));
        if (!(await (0, prompt_1.askYesNo)("Continue anyway?", false))) {
            throw new Error("Aborted — could not verify the RPC chain");
        }
    }
    else {
        console.log(chalk_1.default.green(`  ✓ Confirmed chain id ${chainProfile.chainId} (${chainProfile.name})`));
    }
    const rpcUrls = plan.urls;
    const provider = new ethers_1.JsonRpcProvider(rpcUrls[0]);
    // ── 6. Resolve slug + API key ────────────────────────────────────────────
    // Need the slug for OpenSea drops endpoint access. If user gave a CA, resolve it.
    console.log(chalk_1.default.bold.white("\nOpenSea API key + slug resolution"));
    console.log(chalk_1.default.gray("  Checking for a usable key..."));
    const keyResult = await (0, opensea_key_1.getValidApiKey)({ timeoutMs: 8000 });
    const apiKey = keyResult?.api_key || undefined;
    const apiKeySource = keyResult?.source || "none";
    console.log(chalk_1.default.gray(`  Key source: ${apiKeySource}`));
    if (keyResult) {
        console.log(chalk_1.default.green(`  ✓ Key ready: ${keyResult.source}`));
    }
    else {
        console.log(chalk_1.default.yellow(`  ⚠ No usable OpenSea key available.`));
        console.log(chalk_1.default.gray(`    Phase inventory will still be fetched, but signed`));
        console.log(chalk_1.default.gray(`    mint data may be missing. You'll need a key for`));
        console.log(chalk_1.default.gray(`    allowlist/FCFS phases. Public mint doesn't need one.\n`));
    }
    // Resolve slug — needed for OpenSea drops endpoint
    let slug = null;
    if (!(0, slug_resolver_1.isSlug)(nftInput)) {
        console.log(chalk_1.default.gray(`  Resolving contract → slug for OpenSea drops endpoint...`));
        slug = await (0, slug_resolver_1.resolveContractToSlug)(nftInput, apiKey || "", 12000);
        if (!slug) {
            console.log(chalk_1.default.gray(`  Could not resolve slug for ${nftInput}.`));
            console.log(chalk_1.default.gray(`  Will use contract address directly where possible.`));
        }
        else {
            console.log(chalk_1.default.green(`  ✓ Slug: ${slug}`));
        }
    }
    else {
        // User gave a slug directly — resolve to CA for on-chain reads
        console.log(chalk_1.default.gray(`  Resolving slug → contract address...`));
        try {
            const info = await (0, slug_resolver_1.resolveSlug)(nftInput, apiKey || "", chainKey);
            log.field("resolved_contract", info.contractAddress);
        }
        catch (err) {
            log.warn(`Slug resolution failed: ${err.message}`);
        }
        slug = nftInput;
    }
    log.field("slug", slug || "unknown");
    // ── 7. Warm SIWE sessions for ALL wallets ──────────────────────────────
    // Each wallet needs its own OpenSea session for eligibility + signed payload
    // fetching. The session warming is parallelizable — do it for all wallets.
    console.log(chalk_1.default.bold.white("\nOpenSea sessions"));
    console.log(chalk_1.default.gray(`  Warming SIWE sessions for ${wallets.length} wallet(s)...`));
    const sessionResults = await warmAllSessions(wallets, apiKey);
    log.field("sessions_ready", sessionResults.filter((s) => s.session).length);
    log.field("sessions_failed", sessionResults.filter((s) => !s.session).length);
    for (const result of sessionResults) {
        const label = `${result.wallet.address.slice(0, 6)}…${result.wallet.address.slice(-4)}`;
        if (result.session) {
            console.log(chalk_1.default.green(`  ✓ [W${result.walletIndex}] ${label} session ready`));
        }
        else {
            console.log(chalk_1.default.yellow(`  ⚠ [W${result.walletIndex}] ${label} session failed: ${result.error}`));
        }
    }
    // ── 8. Discover ALL phases ─────────────────────────────────────────────
    // Fetch from OpenSea GraphQL first (primary), then REST, then on-chain SeaDrop
    // discovery for collections not registered on OpenSea.
    console.log(chalk_1.default.bold.white("\nPhase discovery"));
    console.log(chalk_1.default.gray(`  Fetching all active phases for ${target.label}...`));
    const inventory = await discoverAllPhases(nftInput, slug, apiKey, chainKey, 12000);
    log.field("phases_found", inventory.drops.length);
    // ── 8a. Gas (needed by both the phase path and the universal fallback) ──
    console.log(chalk_1.default.bold.white("\nGas"));
    const gas = await (0, wizard_helpers_1.promptGasGwei)(chainProfile, rpcUrls);
    // ── 8b. Universal fallback ─────────────────────────────────────────────
    // OpenSea only knows about drops it hosts. A plain ERC721 with its own
    // mint(), a Manifold claim, a Zora collect, or any contract using a bespoke
    // mint function is invisible to the drops endpoint — and previously that
    // meant "no phases found" and a dead end.
    //
    // Try the universal adapter before giving up. It probes SeaDrop, the generic
    // signature registry, and the contract's own ABI, and only accepts a plan
    // that SIMULATES — so a closed sale or a missing proof is reported as a
    // reason, not silently minted.
    if (inventory.drops.length === 0) {
        console.log(chalk_1.default.bold.white("\nUniversal mint probe"));
        console.log(chalk_1.default.gray("  OpenSea reports no phases — probing the contract directly..."));
        const universal = await (0, universal_mint_1.findUniversalMint)(nftInput, provider, wallets[0].address, BigInt(quantity), {
            rpcUrl: rpcUrls[0],
        });
        if (universal.plan) {
            console.log(chalk_1.default.green(`  ✓ ${universal.plan.description}`));
            console.log(chalk_1.default.gray(`    via ${universal.plan.adapter}`));
            // A universal plan is a single-wallet, single-contract mint. Confirm and
            // execute it directly — there is no phase matrix to pick from.
            const didConfirm = await (0, prompt_1.askYesNo)(`Mint ${quantity} × ${universal.plan.description}?`, true);
            if (!didConfirm) {
                console.log(chalk_1.default.yellow("\n  Aborted — nothing was sent.\n"));
                (0, prompt_1.closePrompts)();
                return;
            }
            await executeUniversalMint(universal.plan, walletKeys, rpcUrls, chainProfile, gas, quantity);
            (0, prompt_1.closePrompts)();
            return;
        }
        console.log(chalk_1.default.yellow("  ✗ No mintable mechanism found on this contract."));
        console.log(chalk_1.default.gray((0, universal_mint_1.explainFailure)(universal)));
        console.log(chalk_1.default.gray("\n  This may not be a mintable contract, the sale may be closed, or it may\n" +
            "  need an allowlist proof / signature this tool cannot obtain."));
        (0, prompt_1.closePrompts)();
        return;
    }
    if (inventory.drops.length === 0) {
        throw new Error(`No mint phases found for ${nftInput}.\n` +
            `  Tried: OpenSea REST/GraphQL + on-chain SeaDrop probe.\n` +
            `  This may not be a SeaDrop collection, or it may need an OpenSea API key.\n` +
            `  Try: paste the OpenSea collection page URL directly.`);
    }
    // ── 9. Probe eligibility for EACH wallet against EACH phase ──────────────
    console.log(chalk_1.default.bold.white("\nEligibility probe"));
    console.log(chalk_1.default.gray(`  Probing ${wallets.length} wallet(s) × ${inventory.drops.length} phase(s)...`));
    const walletEligibilities = await probeAllWallets(wallets, walletKeys, inventory, sessionResults, apiKey, quantity, slug, chainKey);
    // ── 10. Report eligibility matrix ────────────────────────────────────────
    printEligibilityReport(walletEligibilities, inventory);
    // ── 11. Let user pick wallet + phase ────────────────────────────────────
    const selection = await promptWalletAndPhase(walletEligibilities, walletKeys, quantity);
    if (selection === null) {
        console.log(chalk_1.default.yellow("\n  Aborted — nothing was sent.\n"));
        (0, prompt_1.closePrompts)();
        return;
    }
    const { walletIndex, wallet, phaseIndex } = selection;
    const selectedDrop = inventory.drops[phaseIndex];
    const walletEligibility = walletEligibilities[walletIndex];
    const phaseEligibility = walletEligibility.phaseReports[phaseIndex];
    log.field("selected_wallet", wallet.address);
    log.field("selected_phase", selectedDrop.name || selectedDrop.dropId);
    log.field("mint_mode", phaseEligibility.mode);
    // ── 12. Timing ──────────────────────────────────────────────────────────
    // --at / --when-open skip the prompt; otherwise ask.
    let targetStart = new Date(selectedDrop.startTime * 1000);
    let timingLabel;
    if (opts.at) {
        const unix = (0, schedule_1.parseWhen)(opts.at);
        targetStart = new Date(unix * 1000);
        timingLabel = `--at ${opts.at}`;
        console.log(chalk_1.default.gray(`  Scheduled for ${targetStart.toISOString()} (${timingLabel})`));
    }
    else if (opts.whenOpen) {
        timingLabel = "when-open (poll on-chain)";
        console.log(chalk_1.default.gray("  Will poll the on-chain open time."));
    }
    else {
        const prompted = await (0, wizard_helpers_1.promptTiming)(new Date(selectedDrop.startTime * 1000));
        targetStart = prompted.targetStart ?? targetStart;
        timingLabel = prompted.timingLabel;
    }
    // ── 12b. Price protection ───────────────────────────────────────────────
    // Ported from price.js. --max-price sets the cap; otherwise the user is
    // asked. Without it a drop that raised its price between planning and firing
    // would be minted at the new price with no warning.
    let maxPriceWei = null;
    if (opts.maxPrice) {
        const priceSpec = (0, price_protection_1.parsePriceSpec)(opts.maxPrice, quantity);
        if (priceSpec) {
            maxPriceWei = priceSpec.isUnlimited ? null : priceSpec.maxPriceWei;
            console.log(chalk_1.default.gray(`  Price protection: ${priceSpec.display}`));
        }
    }
    // ── 14. Balances + affordability ─────────────────────────────────────────
    console.log(chalk_1.default.bold.white("\nWallets"));
    const balances = await Promise.all(wallets.map((w) => provider.getBalance(w.address).catch(() => null)));
    const symbol = chainProfile.nativeSymbol;
    console.log(chalk_1.default.gray(`  Native token: ${symbol}`));
    // Determine required funds based on mint mode
    let valuePerWallet;
    if (phaseEligibility.mode === "public") {
        // Public mint — price from on-chain
        const localPlan = await (0, seadrop_public_1.buildLocalMintPlan)(rpcUrls[0], nftInput, quantity);
        if (!localPlan)
            throw new Error("Could not build local mint plan for public phase.");
        valuePerWallet = localPlan.value;
    }
    else {
        // Signed/allowlist mint — price from payload
        valuePerWallet = phaseEligibility.signedPayload?.value || selectedDrop.mintPrice * BigInt(quantity);
    }
    const required = BigInt(gas.defaultGasLimit) * gas.maxFeePerGasWei + valuePerWallet;
    const input = {
        chainProfile,
        rpcUrls,
        wallets,
        balances,
        nftContract: nftInput,
        quantity,
        valuePerWallet,
        required,
        gasLimit: gas.defaultGasLimit,
        maxFeePerGas: gas.maxFeePerGasWei,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei,
        targetStart: targetStart,
        timingLabel,
        modeLabel: `${phaseEligibility.mode === "public" ? "PUBLIC (on-chain)" : "SIGNED (OpenSea)"} — ${selectedDrop.name || "selected phase"}`,
        targetLabel: target.label,
        promptForGas: false,
    };
    const { shortCount } = (0, wizard_helpers_1.displayBalances)(input);
    if (shortCount === wallets.length) {
        throw new Error("Every wallet is underfunded — nothing could be broadcast.");
    }
    // ── 15. Confirm ────────────────────────────────────────────────────────
    const didConfirm = await (0, wizard_helpers_1.confirmSnipe)(input);
    if (!didConfirm) {
        (0, prompt_1.closePrompts)();
        return;
    }
    (0, prompt_1.closePrompts)();
    // ── 16. Execute ──────────────────────────────────────────────────────────
    if (phaseEligibility.mode === "public") {
        // Public phase — on-chain calldata, no OpenSea needed
        const localPlan = await (0, seadrop_public_1.buildLocalMintPlan)(rpcUrls[0], nftInput, quantity);
        if (!localPlan) {
            throw new Error("Could not build local mint plan for public phase.");
        }
        await (0, local_mint_1.localPublicSnipe)({
            nftContract: nftInput,
            quantity,
            walletKeys,
            rpcUrls,
            maxFeePerGas: gas.maxFeePerGasWei,
            maxPriorityFee: gas.maxPriorityFeePerGasWei,
            gasLimit: gas.defaultGasLimit,
            targetStart: targetStart || new Date(selectedDrop.startTime * 1000),
            plan: localPlan,
            maxPriceWei,
        });
    }
    else {
        // Signed/allowlist phase — needs OpenSea signed payload
        if (!phaseEligibility.signedPayload) {
            throw new Error(`Signed payload unavailable for phase "${selectedDrop.name || "selected"}".\n` +
                `  OpenSea did not return wallet-specific signed data.\n` +
                `  Get an OpenSea API key and ensure your wallet is allowlisted.\n` +
                `  Or switch to a public phase if one is available.`);
        }
        const payload = phaseEligibility.signedPayload;
        const mintPlan = (0, fcfs_mint_1.buildFcfsMintPlan)(payload, gas.defaultGasLimit, gas.maxFeePerGasWei, gas.maxPriorityFeePerGasWei, quantity);
        // Pre-fetch a signed payload for EVERY wallet now, while the drop is still
        // future. mintSignature is wallet-specific, so each wallet needs its own.
        // Passing these in keeps the T-0 path free of API calls.
        console.log(chalk_1.default.gray(`\n  Pre-fetching signed payloads for ${walletKeys.length} wallet(s)...`));
        const preFetched = [];
        for (let i = 0; i < walletKeys.length; i++) {
            const w = new ethers_1.Wallet(walletKeys[i]);
            try {
                const p = await (0, fcfs_mint_1.fetchSignedPayloadForWallet)(nftInput, quantity, w.address, apiKey, { timeoutMs: 15000, session: sessionResults[i]?.session ?? null, slug: slug || undefined, chainKey });
                preFetched.push(p);
                if (!p)
                    console.log(chalk_1.default.yellow(`    ${w.address} — no payload (will retry at T-0)`));
            }
            catch (err) {
                console.log(chalk_1.default.yellow(`    ${w.address} — pre-fetch failed: ${err.message}`));
                preFetched.push(null);
            }
        }
        await (0, fcfs_mint_1.executeFcfsSnipe)({
            nftContract: nftInput,
            quantity,
            walletKeys,
            rpcUrls,
            maxFeePerGas: gas.maxFeePerGasWei,
            maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei,
            gasLimit: gas.defaultGasLimit,
            targetStart: targetStart || new Date(selectedDrop.startTime * 1000),
            plan: mintPlan,
            payloads: preFetched,
            sessions: sessionResults.map((sr) => sr.session),
            slug: slug || undefined,
            chainKey,
            maxPriceWei,
        });
    }
}
// ── Universal mint execution ────────────────────────────────────────────────
//
// Broadcasts a plan produced by findUniversalMint. Unlike the phase paths this
// has no signed payload and no per-wallet variation — the calldata is identical
// for every wallet, so it is encoded once and blasted to every endpoint.
async function executeUniversalMint(plan, walletKeys, rpcUrls, chainProfile, gas, quantity) {
    console.log(chalk_1.default.bold.white("\nBroadcasting"));
    console.log(chalk_1.default.gray(`  ${walletKeys.length} wallet(s) × ${rpcUrls.length} endpoint(s)`));
    const results = [];
    for (const key of walletKeys) {
        const wallet = new ethers_1.Wallet(key);
        const txRequest = {
            to: plan.to,
            data: plan.data,
            value: plan.value,
            gasLimit: gas.defaultGasLimit,
            maxFeePerGas: gas.maxFeePerGasWei,
            maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei,
        };
        // Re-simulate immediately before signing. The plan was simulated during
        // discovery, but a live sale can close between then and now — and a revert
        // costs gas to discover on-chain.
        const simProvider = new ethers_1.JsonRpcProvider(rpcUrls[0]);
        let sim;
        try {
            sim = await (0, simulate_1.simulateTx)(simProvider, {
                to: plan.to,
                from: wallet.address,
                data: plan.data,
                value: plan.value,
            });
        }
        finally {
            // ethers keeps a polling timer alive on every provider. Without an
            // explicit destroy the process never exits — the work is done but the
            // event loop stays busy forever.
            try {
                simProvider.destroy();
            }
            catch {
                // Already destroyed.
            }
        }
        if (!sim.ok && sim.reverted) {
            const classified = (0, simulate_1.classifyRevert)(sim.reason);
            results.push({
                wallet: wallet.address,
                ok: false,
                error: `${classified ? `[${classified.label}] ` : ""}${sim.reason ?? "reverted"}`,
            });
            continue;
        }
        try {
            const signed = await wallet.signTransaction(txRequest);
            const endpoints = (0, rpc_blast_1.parseRpcEndpoints)(rpcUrls);
            const { txHash } = (0, rpc_blast_2.blastToAll)(signed, endpoints);
            results.push({ wallet: wallet.address, ok: true, hash: txHash });
            console.log(chalk_1.default.green(`  ✓ ${short(wallet.address)} — ${short(txHash)}`));
        }
        catch (err) {
            results.push({ wallet: wallet.address, ok: false, error: err.message });
            console.log(chalk_1.default.red(`  ✗ ${short(wallet.address)} — ${err.message}`));
        }
    }
    const okCount = results.filter((r) => r.ok).length;
    console.log(chalk_1.default.bold(`\n  ${okCount}/${results.length} wallet(s) broadcast`));
    if (okCount === 0) {
        throw new Error("Every wallet failed to broadcast — nothing was sent.");
    }
}
// ── Phase discovery: OpenSea REST + on-chain fallback ─────────────────────────
async function discoverAllPhases(nftContract, slug, apiKey, chainKey, timeoutMs) {
    // Try OpenSea first — works with CAs or slugs
    let inventory = await (0, fcfs_drops_1.fetchAllActiveDrops)(nftContract, apiKey || undefined, timeoutMs, slug || undefined, chainKey);
    // If OpenSea didn't find anything, try on-chain SeaDrop discovery
    if (inventory.drops.length === 0) {
        console.log(chalk_1.default.gray(`  OpenSea: no active phases — trying on-chain SeaDrop probe...`));
        const onChainDrops = await (0, seadrop_onchain_1.fetchOnChainDrops)(nftContract, timeoutMs, chainKey);
        if (onChainDrops.length > 0) {
            console.log(chalk_1.default.green(`  ✓ Found ${onChainDrops.length} on-chain phase(s).`));
            inventory.drops = onChainDrops;
            inventory.fetchedAt = Date.now();
            inventory.apiKeyUsed = !!apiKey;
        }
        else if (!apiKey) {
            // Try single-contract on-chain drop as last resort
            console.log(chalk_1.default.gray(`    OpenSea REST 404'd — checking single-contract on-chain drop...`));
            const singleDrop = await (0, seadrop_onchain_1.fetchSingleOnChainDrop)(nftContract, 8000, chainKey);
            if (singleDrop) {
                console.log(chalk_1.default.green(`  ✓ Found on-chain drop for this contract.`));
                inventory.drops = [singleDrop];
                inventory.fetchedAt = Date.now();
                inventory.apiKeyUsed = false;
            }
        }
    }
    return inventory;
}
// Parse a per-wallet cookie string (from getSessionCookies) into a StoredSession.
// Extracts access_token + refresh_token from the cookie jar and decodes JWT exp.
function cookiesToStoredSession(cookies) {
    const accessMatch = cookies.match(/(?:^|;\s*)access_token=([^;]+)/);
    const refreshMatch = cookies.match(/(?:^|;\s*)refresh_token=([^;]+)/);
    const token = accessMatch?.[1]?.trim();
    const refreshToken = refreshMatch?.[1]?.trim();
    if (!token)
        return null;
    // Decode JWT exp claim (no verification needed — just reading expiry)
    let exp = 0;
    try {
        const parts = token.split(".");
        if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
            exp = (payload.exp || 0) * 1000; // JWT exp is in seconds → ms
        }
    }
    catch { }
    return {
        accessToken: token,
        refreshToken,
        expiresAt: exp,
    };
}
async function warmAllSessions(wallets, _apiKey) {
    const results = await Promise.all(wallets.map(async (w, i) => {
        try {
            // Each wallet gets its own SIWE session via getSessionCookies,
            // which caches per-address internally in opensea-session.ts.
            const cookies = await (0, opensea_session_1.getSessionCookies)(w);
            if (cookies) {
                // Build a per-wallet StoredSession from that wallet's cookies.
                const session = cookiesToStoredSession(cookies);
                return { walletIndex: i, wallet: w, session, error: null };
            }
            return { walletIndex: i, wallet: w, session: null, error: "SIWE login failed" };
        }
        catch (err) {
            // Non-fatal — some collections don't need sessions
            return { walletIndex: i, wallet: w, session: null, error: err.message };
        }
    }));
    return results;
}
// ── Eligibility probing for ALL wallets × ALL phases ────────────────────────
async function probeAllWallets(wallets, walletKeys, inventory, sessionResults, apiKey, quantity, collectionSlug, chainKey) {
    const results = [];
    // Soonest-starting phase first. The wizard's phase picker indexes into this
    // array, and the pre-fetch loop walks it in order — an unsorted inventory
    // means the sniper can target a later phase while an earlier one opens.
    const orderedDrops = (0, fcfs_drops_1.orderDropsByStartTime)(inventory.drops);
    for (let wIdx = 0; wIdx < wallets.length; wIdx++) {
        const wallet = wallets[wIdx];
        const walletAddr = wallet.address.toLowerCase();
        const phaseReports = [];
        const session = sessionResults[wIdx]?.session ?? null;
        for (const drop of orderedDrops) {
            const report = await probePhaseForWallet(wallet, walletAddr, drop, apiKey, quantity, session, collectionSlug, chainKey);
            phaseReports.push(report);
        }
        results.push({
            walletIndex: wIdx,
            walletAddress: wallet.address,
            phaseReports,
        });
    }
    return results;
}
async function probePhaseForWallet(wallet, walletAddr, drop, apiKey, quantity, session, collectionSlug, chainKey) {
    // 1. Run local classification
    const { mode, fireableLocally, preFetchNeeded } = (0, fcfs_mint_1.classifyMintMode)(drop);
    // 2. Determine eligibility
    let eligible = false;
    let reason = "";
    let signedPayload = null;
    let signedPayloadError = null;
    let dropEligibilityInfo = null;
    let restEligibility = null;
    if (mode === "public") {
        // Public phase — always eligible (on-chain, no allowlist)
        eligible = true;
        reason = "Public phase — open to all, no allowlist required.";
    }
    else if (mode === "signed" || mode === "allowlist") {
        // Non-public phase — check per-stage eligibility. Two documented paths:
        //   1. GQL DropEligibilityQuery (richer: names the eligible wallet, quotes
        //      a per-wallet price). Requires a wallet JWT.
        //   2. REST GET /api/v2/drops/{slug}/eligibility (the API's own endpoint;
        //      same JWT requirement, simpler response).
        // Try GQL first, then REST, and use whichever answers. Both need a session.
        if (collectionSlug && session) {
            const cookie = (0, fcfs_mint_1.sessionToStoredSessionCookie)(session);
            try {
                dropEligibilityInfo = await (0, opensea_gql_1.getDropEligibility)(collectionSlug, walletAddr, cookie, apiKey, 12000);
            }
            catch {
                dropEligibilityInfo = null;
            }
            // REST fallback when GQL yielded nothing usable (rate-limited, or the
            // eligibility fields came back UNAUTHORIZED).
            if (!dropEligibilityInfo || !dropEligibilityInfo.authed) {
                const rest = await (0, opensea_gql_1.fetchRestEligibility)(collectionSlug, cookie, apiKey, 12000);
                if (rest) {
                    restEligibility = rest;
                    console.log(chalk_1.default.gray(`    REST eligibility: ${rest.stages.filter((s) => s.isEligible).length}/${rest.stages.length} stage(s) eligible`));
                }
            }
        }
        // Check if GQL already confirmed the wallet is NOT eligible for any stage.
        if (dropEligibilityInfo && dropEligibilityInfo.authed) {
            // OpenSea names the wallet each stage's eligibility belongs to. If it
            // names a different address, this result is not about our wallet and the
            // isEligible flags must not be trusted.
            const foreignStage = dropEligibilityInfo.stages.find((s) => s.eligibleMinterAddress &&
                s.eligibleMinterAddress.toLowerCase() !== walletAddr.toLowerCase());
            if (foreignStage) {
                eligible = false;
                reason = `GQL DropEligibilityQuery returned eligibility for ${foreignStage.eligibleMinterAddress}, not ${walletAddr} — ignoring.`;
            }
            else {
                const anyEligible = dropEligibilityInfo.stages.some((s) => s.isEligible === true);
                if (!anyEligible) {
                    eligible = false;
                    reason = "GQL DropEligibilityQuery: wallet is authenticated but not eligible for any stage.";
                    // Skip the signed payload fetch — wallet is confirmed not allowlisted.
                }
                else {
                    eligible = true;
                    reason = "GQL DropEligibilityQuery: wallet is eligible for at least one stage.";
                }
            }
        }
        else if (restEligibility) {
            // GQL gave nothing usable; the REST endpoint answered. It is
            // wallet-scoped (the JWT identifies the wallet), so a positive result
            // is authoritative.
            const anyEligible = restEligibility.stages.some((s) => s.isEligible);
            if (anyEligible) {
                eligible = true;
                reason = "REST eligibility: wallet is eligible for at least one stage.";
            }
            else {
                eligible = false;
                reason = "REST eligibility: wallet is not eligible for any stage.";
            }
        }
        // If not already resolved by GQL pre-check, try to fetch signed payload
        if (!eligible) {
            // Non-public phase — try to fetch signed payload for this specific wallet
            // Use the slug if available for better slug→CA resolution
            try {
                // Try with API key first (path A)
                signedPayload = await (0, fcfs_mint_1.fetchSignedPayload)(drop.nftContract, quantity, apiKey, { timeoutMs: 12000, walletAddress: wallet.address, slug: collectionSlug || undefined, chainKey });
                if (signedPayload) {
                    // OpenSea quoted a per-wallet price for this stage. A mismatch is
                    // worth surfacing, but the units of GQL `eligiblePrice.token.unit`
                    // are not documented, so we WARN rather than reject — a false
                    // rejection here would silently skip a mint we were eligible for.
                    // TODO: confirm the unit (wei vs ETH) against a live drop, then
                    // promote this to a hard check.
                    const quoted = dropEligibilityInfo?.stages.find((s) => s.isEligible === true && s.priceUnit != null)?.priceUnit;
                    if (quoted != null) {
                        const expectedWei = BigInt(quoted) * BigInt(quantity);
                        if (signedPayload.value !== expectedWei) {
                            console.warn(`    ⚠ Price mismatch for ${wallet.address}: payload value ${signedPayload.value} wei ` +
                                `vs OpenSea quoted ${quoted} × ${quantity} = ${expectedWei} wei. Proceeding.`);
                        }
                    }
                    eligible = true;
                    reason = "Signed payload fetched successfully — wallet is allowlisted.";
                }
                else {
                    // Use the per-wallet SIWE session from warmAllSessions
                    if (session) {
                        signedPayload = await (0, fcfs_mint_1.fetchSignedPayloadWithSession)(drop.nftContract, quantity, session, apiKey, { timeoutMs: 12000, walletAddress: wallet.address, slug: collectionSlug || undefined, chainKey });
                        if (signedPayload) {
                            eligible = true;
                            reason = "Signed payload fetched with SIWE session — wallet is allowlisted.";
                        }
                        else {
                            eligible = false;
                            reason = "No signed payload available. Wallet may not be allowlisted, or needs a live session.";
                        }
                    }
                    else {
                        eligible = false;
                        signedPayloadError = "No SIWE session available for wallet.";
                        reason = "Signed payload requires OpenSea session (SIWE) — no session available.";
                    }
                }
            }
            catch (err) {
                if (err.message?.includes("rate-limited")) {
                    signedPayloadError = err.message;
                    eligible = false;
                    reason = `OpenSea rate-limited the signed payload lookup. Retry in a few seconds.`;
                }
                else {
                    signedPayloadError = err.message;
                    eligible = false;
                    reason = `Error fetching signed payload: ${err.message}`;
                }
            }
        }
    }
    else if (mode === "token-gated") {
        // Token-gated — check if wallet holds the gate token
        // On-chain phases don't have gate token info; need OpenSea metadata
        const baseReport = (0, fcfs_drops_1.assessDropEligibility)(drop, walletAddr);
        eligible = baseReport.ourWalletEligible ?? false;
        reason = baseReport.reason;
    }
    else {
        // Unknown mode — use base eligibility
        const baseReport = (0, fcfs_drops_1.assessDropEligibility)(drop, walletAddr);
        eligible = baseReport.ourWalletEligible ?? false;
        reason = baseReport.reason;
    }
    return {
        drop,
        signedPayload,
        signedPayloadError,
        dropEligibilityInfo,
        restEligibility,
        eligible,
        reason,
        mode,
        fireableLocally,
        preFetchNeeded,
    };
}
// ── Eligibility report display ────────────────────────────────────────────────
function printEligibilityReport(walletEligibilities, inventory) {
    console.log(chalk_1.default.bold.white("\n═══════════════════════════════════════════════════════════════"));
    console.log(chalk_1.default.bold.white("  ELIGIBILITY REPORT"));
    console.log(chalk_1.default.bold.white("═══════════════════════════════════════════════════════════════"));
    for (let wIdx = 0; wIdx < walletEligibilities.length; wIdx++) {
        const we = walletEligibilities[wIdx];
        const shortAddr = `${we.walletAddress.slice(0, 6)}…${we.walletAddress.slice(-4)}`;
        const eligibleCount = we.phaseReports.filter((r) => r.eligible).length;
        const totalCount = we.phaseReports.length;
        console.log(chalk_1.default.bold(`\n  Wallet ${wIdx} — ${shortAddr} (${eligibleCount}/${totalCount} eligible)`));
        for (let pIdx = 0; pIdx < we.phaseReports.length; pIdx++) {
            const report = we.phaseReports[pIdx];
            const drop = report.drop;
            const startsAt = new Date(drop.startTime * 1000);
            const endsAt = new Date(drop.endTime * 1000);
            const now = Date.now();
            const isLive = now >= drop.startTime * 1000 && now < drop.endTime * 1000;
            const liveBadge = isLive
                ? chalk_1.default.green("(LIVE)")
                : now < drop.startTime * 1000
                    ? chalk_1.default.yellow("(future)")
                    : chalk_1.default.gray("(ended)");
            const modeBadge = report.mode === "public"
                ? chalk_1.default.green("[PUBLIC]")
                : report.mode === "signed"
                    ? chalk_1.default.blue("[SIGNED]")
                    : report.mode === "allowlist"
                        ? chalk_1.default.magenta("[ALLOWLIST]")
                        : chalk_1.default.gray(`[${report.mode?.toUpperCase() || "UNKNOWN"}]`);
            const eligBadge = report.eligible
                ? chalk_1.default.green("✓ ELIGIBLE")
                : report.signedPayloadError?.includes("rate-limit")
                    ? chalk_1.default.yellow("⚠ RATE-LIMITED")
                    : report.signedPayload
                        ? chalk_1.default.green("✓ ELIGIBLE (signed)")
                        : chalk_1.default.red("✗ NOT ELIGIBLE");
            console.log(chalk_1.default.gray(`    └─ Phase ${pIdx}: ${drop.name || "unnamed"} ${modeBadge} ${liveBadge} ${eligBadge}`));
            console.log(chalk_1.default.gray(`       type: ${drop.type || "unknown"} | price: ${(0, ethers_1.formatEther)(drop.mintPrice)} ETH`));
            console.log(chalk_1.default.gray(`       reason: ${report.reason}`));
            if (report.signedPayload && report.mode !== "public") {
                console.log(chalk_1.default.gray(`       signed: ✓ ${report.signedPayload.mintData.slice(0, 20)}…`));
            }
        }
    }
    // Summary: which wallet × phase combos are eligible
    console.log(chalk_1.default.bold.white("\n───────────────────────────────────────────────────────────────"));
    console.log(chalk_1.default.bold.white("  SUMMARY — Eligible targets"));
    console.log(chalk_1.default.bold.white("───────────────────────────────────────────────────────────────"));
    let hasEligible = false;
    for (let wIdx = 0; wIdx < walletEligibilities.length; wIdx++) {
        const we = walletEligibilities[wIdx];
        const shortAddr = `${we.walletAddress.slice(0, 6)}…${we.walletAddress.slice(-4)}`;
        for (let pIdx = 0; pIdx < we.phaseReports.length; pIdx++) {
            const report = we.phaseReports[pIdx];
            if (report.eligible) {
                hasEligible = true;
                const drop = report.drop;
                const isLive = Date.now() >= drop.startTime * 1000 && Date.now() < drop.endTime * 1000;
                const liveStr = isLive ? chalk_1.default.green("LIVE") : chalk_1.default.yellow("waiting");
                console.log(chalk_1.default.gray(`    W${wIdx} ${shortAddr} → Phase ${pIdx}: ${drop.name || "unnamed"} [${report.mode}] ${liveStr}`));
            }
        }
    }
    if (!hasEligible) {
        console.log(chalk_1.default.yellow("  No wallet×phase combinations are eligible right now."));
        console.log(chalk_1.default.gray("  Check allowlist status, or wait for a public phase to open."));
    }
    console.log(chalk_1.default.bold.white("───────────────────────────────────────────────────────────────\n"));
}
async function promptWalletAndPhase(walletEligibilities, walletKeys, quantity) {
    // Build a flat list of all eligible wallet×phase combos
    const eligible = [];
    for (let wIdx = 0; wIdx < walletEligibilities.length; wIdx++) {
        const we = walletEligibilities[wIdx];
        for (let pIdx = 0; pIdx < we.phaseReports.length; pIdx++) {
            const report = we.phaseReports[pIdx];
            if (report.eligible) {
                const price = report.mode === "public"
                    ? report.drop.mintPrice * BigInt(quantity)
                    : report.signedPayload?.value || report.drop.mintPrice * BigInt(quantity);
                const isLive = Date.now() >= report.drop.startTime * 1000 && Date.now() < report.drop.endTime * 1000;
                eligible.push({
                    wIdx, pIdx,
                    price,
                    mode: report.mode,
                    live: isLive,
                });
            }
        }
    }
    if (eligible.length === 0) {
        console.log(chalk_1.default.yellow("  No eligible wallet×phase combinations found."));
        console.log(chalk_1.default.gray("  Options:"));
        console.log(chalk_1.default.gray("    • Run the eligibility check with different wallets"));
        console.log(chalk_1.default.gray("    • Wait for a public phase to open (no allowlist needed)"));
        console.log(chalk_1.default.gray("    • Get an OpenSea API key + ensure wallet is on the allowlist"));
        return null;
    }
    console.log(chalk_1.default.bold.white("\nEligible targets:"));
    eligible.forEach((e, i) => {
        const we = walletEligibilities[e.wIdx];
        const shortAddr = `${we.walletAddress.slice(0, 6)}…${we.walletAddress.slice(-4)}`;
        const drop = we.phaseReports[e.pIdx].drop;
        const liveStr = e.live ? chalk_1.default.green("LIVE") : chalk_1.default.gray("waiting");
        console.log(chalk_1.default.gray(`  [${i + 1}] Wallet ${e.wIdx} ${shortAddr} → ${drop.name || "unnamed"} ` +
            `[${e.mode}] ${liveStr} — ${(0, ethers_1.formatEther)(e.price)} ETH`));
    });
    // Auto-select if there's only one eligible option
    if (eligible.length === 1) {
        const e = eligible[0];
        const we = walletEligibilities[e.wIdx];
        const shortAddr = `${we.walletAddress.slice(0, 6)}…${we.walletAddress.slice(-4)}`;
        console.log(chalk_1.default.green(`\n  ✓ Auto-selected: Wallet ${e.wIdx} ${shortAddr} → Phase ${e.pIdx}`));
        return {
            walletIndex: e.wIdx,
            wallet: new ethers_1.Wallet(walletKeys[e.wIdx]),
            phaseIndex: e.pIdx,
        };
    }
    // Prompt for selection
    const choice = await (0, prompt_1.askText)(chalk_1.default.gray(`  Select target (1-${eligible.length}, default 1): `));
    let selectedIndex = 0;
    if (choice && choice.trim().length > 0) {
        const parsed = parseInt(choice.trim(), 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= eligible.length) {
            selectedIndex = parsed - 1;
        }
        else {
            console.log(chalk_1.default.yellow(`  Invalid number — using first eligible target.`));
        }
    }
    const e = eligible[selectedIndex];
    return {
        walletIndex: e.wIdx,
        wallet: new ethers_1.Wallet(walletKeys[e.wIdx]),
        phaseIndex: e.pIdx,
    };
}
// ── Steps ───────────────────────────────────────────────────────────────────
async function promptKeys(log, spec) {
    console.log(chalk_1.default.bold.white("Private keys"));
    // A --wallets spec with a PRIVATE_KEY in the environment means the user has
    // already supplied keys non-interactively. Load them rather than prompting,
    // which is what makes a headless run possible.
    const envKeys = loadEnvKeys();
    if (envKeys.length > 0 && spec) {
        const selected = selectFromLoaded(envKeys, spec);
        console.log(chalk_1.default.gray(`  ${selected.length} wallet(s) from environment (${spec}).`));
        for (const w of selected) {
            console.log(chalk_1.default.green(`  ✓ ${w.address}`));
        }
        return selected.map((w) => w.privateKey);
    }
    if (envKeys.length > 0 && process.env.PRIVATE_KEY && !process.stdin.isTTY) {
        // Non-interactive stdin with a key present: use it rather than hanging on a
        // prompt that can never be answered.
        console.log(chalk_1.default.gray(`  ${envKeys.length} wallet(s) from environment.`));
        return envKeys.map((w) => w.privateKey);
    }
    console.log(chalk_1.default.gray("  Paste one key per line — typing is hidden. Blank line when done."));
    console.log(chalk_1.default.gray("  Each key is confirmed by its wallet address. Nothing is saved to disk."));
    const keys = [];
    const seen = new Set();
    for (;;) {
        const raw = await (0, prompt_1.askHidden)(chalk_1.default.gray(`  › key ${keys.length + 1}: `));
        if (!raw) {
            if (keys.length === 0) {
                console.log(chalk_1.default.red("  ✗ Need at least one key."));
                continue;
            }
            break;
        }
        const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
        let wallet;
        try {
            wallet = new ethers_1.Wallet(normalized);
        }
        catch {
            console.log(chalk_1.default.red("  ✗ Not a valid private key — try again."));
            continue;
        }
        if (seen.has(wallet.address.toLowerCase())) {
            console.log(chalk_1.default.yellow(`  ⚠ Duplicate of ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)} — skipped.`));
            continue;
        }
        seen.add(wallet.address.toLowerCase());
        keys.push(normalized);
        console.log(chalk_1.default.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
    }
    // Store keys for wallet reconstruction during selection
    console.log(chalk_1.default.gray(`  ${keys.length} wallet(s) loaded.`));
    return keys;
}
function loadEnvKeys() {
    const list = [];
    const seen = new Set();
    const add = (pk) => {
        if (!pk || typeof pk !== "string")
            return;
        let w;
        try {
            w = new ethers_1.Wallet(pk.trim());
        }
        catch {
            return;
        }
        if (seen.has(w.address.toLowerCase()))
            return;
        seen.add(w.address.toLowerCase());
        list.push({ address: w.address, privateKey: pk.trim() });
    };
    add(process.env.PRIVATE_KEY);
    (process.env.PRIVATE_KEYS || "").split(",").forEach(add);
    const file = process.env.WALLETS_FILE || "wallets.json";
    try {
        if (fs_1.default.existsSync(file)) {
            const j = JSON.parse(fs_1.default.readFileSync(file, "utf8"));
            const arr = Array.isArray(j) ? j : j.wallets || [];
            for (const e of arr)
                add(typeof e === "string" ? e : e.pk || e.privateKey);
        }
    }
    catch {
        // A malformed wallets file is not fatal — fall back to the env keys.
    }
    return list;
}
/**
 * Select a subset by spec: all | * | N | 1,3,4 (1-based).
 * Ported from wallets.js selectWallets().
 */
function selectFromLoaded(all, spec) {
    if (!all.length)
        return [];
    const s = String(spec).trim().toLowerCase();
    if (s === "all" || s === "*")
        return all;
    if (/^\d+$/.test(s))
        return all.slice(0, Math.max(1, Math.min(Number(s), all.length)));
    if (/^[0-9,\s]+$/.test(s)) {
        const idx = s
            .split(",")
            .map((x) => Number(x.trim()) - 1)
            .filter((i) => Number.isInteger(i) && i >= 0 && i < all.length);
        if (idx.length)
            return idx.map((i) => all[i]);
    }
    return [all[0]];
}
async function promptQuantity(walletCount) {
    console.log(chalk_1.default.bold.white("\nQuantity"));
    const qty = await (0, prompt_1.askNumber)("NFTs per wallet", 1, { min: 1, max: 100 });
    if (walletCount > 1) {
        console.log(chalk_1.default.gray(`  → ${qty} × ${walletCount} wallets = ${qty * walletCount} total`));
    }
    return Math.floor(qty);
}
async function promptTarget(log, chainKey, prefill) {
    console.log(chalk_1.default.bold.white("\nNFT target"));
    console.log(chalk_1.default.gray("  Paste an OpenSea, Scatter, Zora or Manifold link, a collection slug, or a contract address."));
    console.log(chalk_1.default.gray("  Chain aliases work too: \"0xabc… on base\", \"slug matic\", \"--chain arb\"."));
    let activeChain = chainKey;
    for (;;) {
        const raw = prefill ?? (await (0, prompt_1.askText)("NFT link"));
        // A pre-filled target is tried once; if it fails, fall through to the
        // prompt so the user can correct it rather than the run just dying.
        prefill = null;
        if (!raw) {
            console.log(chalk_1.default.red("  ✗ Paste a link, slug, or address."));
            continue;
        }
        let parsed;
        try {
            parsed = (0, target_resolver_1.parseTarget)(raw);
        }
        catch (err) {
            console.log(chalk_1.default.red(`  ✗ ${err.message}`));
            continue;
        }
        // A chain named in the input overrides the one chosen at the top — the user
        // typed it, so it is the more specific instruction.
        const namedChain = parsed.chain ? (0, target_resolver_1.chainSlug)(parsed.chain) : undefined;
        if (namedChain && (0, chains_1.resolveChain)(namedChain)) {
            if (namedChain !== activeChain) {
                console.log(chalk_1.default.gray(`  ↳ Chain set to ${(0, chains_1.resolveChain)(namedChain).name} (from input)`));
                activeChain = namedChain;
            }
        }
        else if (parsed.chain) {
            console.log(chalk_1.default.yellow(`  ⚠ Unknown chain "${parsed.chain}" — using ${(0, chains_1.resolveChain)(activeChain).name}.`));
        }
        // Manifold cannot be resolved to a contract from a claim slug. Say so
        // immediately rather than letting the user wait through a failed lookup.
        if (parsed.platform === "manifold") {
            console.log(chalk_1.default.red(`  ✗ Manifold claim "${parsed.claimId}" cannot be resolved automatically — Manifold claims need the claim contract address.`));
            console.log(chalk_1.default.gray("    Paste the 0x… contract address instead."));
            continue;
        }
        // Resolve to a concrete contract. This is where a bare slug gets disambiguated
        // between OpenSea and Scatter.
        let resolved = null;
        try {
            resolved = await (0, target_resolver_1.resolveTarget)(parsed, process.env.OPENSEA_API_KEY || "", activeChain);
        }
        catch (err) {
            console.log(chalk_1.default.yellow(`  ⚠ Resolution issue: ${err.message}`));
        }
        if (!resolved) {
            console.log(chalk_1.default.red(`  ✗ Could not resolve "${raw}" — the collection may not exist, or it needs an OpenSea API key.`));
            continue;
        }
        const label = resolved.platform === "scatter"
            ? `${resolved.scatter?.name ?? resolved.slug} (Scatter)`
            : resolved.platform === "opensea" && resolved.slug
                ? `${resolved.slug} (OpenSea)`
                : resolved.contract;
        console.log(chalk_1.default.green(`  ✓ ${resolved.platform.toUpperCase()} — ${label} on ${(0, chains_1.resolveChain)(resolved.chainKey)?.name ?? resolved.chainKey}`));
        if (resolved.resolvedViaFallback) {
            console.log(chalk_1.default.gray("    (resolved via fallback — verify the contract before minting)"));
        }
        return { contract: resolved.contract, label, chainKey: resolved.chainKey, resolved };
    }
}
async function promptRpc(chainProfile) {
    const envUrls = (0, rpc_resolver_1.privateRpcsFromEnv)(chainProfile.key);
    if (envUrls.length > 0) {
        console.log(chalk_1.default.gray(`  Using ${envUrls.length} endpoint(s) from .env (RPC_URL_${chainProfile.key.toUpperCase()}):`));
        for (const u of envUrls)
            console.log(chalk_1.default.gray(`    ${(0, rpc_resolver_1.maskRpc)(u)}`));
        return envUrls;
    }
    // No .env RPCs — use the public endpoints from chains.ts, silently.
    console.log(chalk_1.default.gray(`  No .env RPC configured for ${chainProfile.name} — using public endpoints.`));
    return chainProfile.rpc.public;
}
function printBanner() {
    console.log(chalk_1.default.bold.white(`\n╔${"═".repeat(58)}╗\n║  NFT MINT SNIPER — Universal (public + signed + allowlist)  ║\n╚${"═".repeat(58)}╝`));
    console.log(chalk_1.default.gray("  Probes wallet eligibility across all phases before minting.\n"));
}
function labelOf(url) {
    try {
        return new URL(url).hostname;
    }
    catch {
        return url;
    }
}
function short(addr) {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function formatRemaining(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60)
        return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60)
        return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
}
function gweiToWei(gwei) {
    return BigInt(Math.round(gwei * 1e9));
}
async function currentBaseFeeGwei(provider) {
    const block = await provider.getBlock("latest");
    if (!block)
        return null;
    const baseFee = block.baseFeePerGas;
    if (!baseFee)
        return null;
    return Number(baseFee) / 1e9;
}
//# sourceMappingURL=wizard.js.map