"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runFcfsBranch = runFcfsBranch;
exports.runEligibilityCheck = runEligibilityCheck;
exports.runFcfsBranchCli = runFcfsBranchCli;
const chalk_1 = __importDefault(require("chalk"));
const ethers_1 = require("ethers");
const chains_1 = require("./chains");
const rpc_resolver_1 = require("./rpc-resolver");
const fcfs_drops_1 = require("./fcfs-drops");
const seadrop_onchain_1 = require("./seadrop-onchain");
const fcfs_mint_1 = require("./fcfs-mint");
const opensea_key_1 = require("./opensea-key");
const prompt_1 = require("./prompt");
const slug_resolver_1 = require("./slug-resolver");
const target_resolver_1 = require("./target-resolver");
const schedule_1 = require("./schedule");
const wizard_1 = require("./wizard");
const wizard_helpers_1 = require("./wizard-helpers");
const time_format_1 = require("./time-format");
// ── Main FCFS branch entry ──────────────────────────────────────────────────
async function runFcfsBranch(log, walletKeys, chainProfile, chainKey, nftContract, quantity, rpcUrls, target) {
    log.info("FCFS branch: started");
    log.field("nftContract", nftContract);
    log.field("chain", chainKey);
    log.field("chainProfile", chainProfile.name);
    log.field("quantity", quantity);
    log.field("wallet_count", walletKeys.length);
    log.field("rpc_count", rpcUrls.length);
    log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
    const wallets = walletKeys.map((k) => new ethers_1.Wallet(k));
    const ourWallet = wallets[0].address.toLowerCase();
    // ── Step 0: Get an OpenSea API key (best-effort) ────────────────────────
    // The inventory can be fetched with or without a key. A key gives more data
    // (eligibility, signed mint data). Without a key, we still show what OpenSea
    // knows about the phases, but signed mint data may be absent.
    console.log(chalk_1.default.bold.white("\nOpenSea API key"));
    console.log(chalk_1.default.gray("  Checking for a usable key..."));
    const keyResult = await (0, opensea_key_1.getValidApiKey)({ timeoutMs: 8000 });
    const apiKey = keyResult?.api_key || undefined;
    if (keyResult) {
        console.log(chalk_1.default.green(`  ✓ Key ready: ${keyResult.source}`));
    }
    else {
        console.log(chalk_1.default.yellow(`  ⚠ No usable OpenSea key available.`));
        console.log(chalk_1.default.gray(`    The phase inventory will still be fetched, but signed`));
        console.log(chalk_1.default.gray(`    mint data may be missing. You'll need a key for the actual`));
        console.log(chalk_1.default.gray(`    mint. Public mint path doesn't need a key.\n`));
    }
    // ── Step 1: Fetch ALL active phases for this collection ──────────────────
    console.log(chalk_1.default.bold.white("\nCollection phases"));
    console.log(chalk_1.default.gray(`  Fetching all active phases for ${nftContract}...`));
    const inventory = await (0, fcfs_drops_1.fetchAllActiveDrops)(nftContract, apiKey, 12000);
    if (inventory.drops.length === 0) {
        console.log(chalk_1.default.yellow(`\n  ⚠ No active phases found for ${nftContract}.`));
        // When OpenSea REST/GraphQL drops aren't available, fall through to the
        // on-chain SEADROP check. Some collections (like de-bots) register their
        // phases on-chain rather than through OpenSea's drops API.
        console.log(chalk_1.default.gray(`    OpenSea REST drops 404'd — trying on-chain SEADROP fallback...`));
        const onChainDrops = await (0, seadrop_onchain_1.fetchOnChainDrops)(nftContract, 12000, chainKey);
        if (onChainDrops.length > 0) {
            console.log(chalk_1.default.green(`  ✓ Found ${onChainDrops.length} on-chain phase(s).`));
            // Create a synthetic inventory from on-chain data
            inventory.drops = onChainDrops;
            inventory.fetchedAt = Date.now();
            inventory.apiKeyUsed = false;
        }
        else {
            console.log(chalk_1.default.yellow(`\n  ⚠ No on-chain phases found either.`));
            if (!apiKey) {
                console.log(chalk_1.default.yellow(`  Try: get an OpenSea free API key and re-run.`));
                // For collections like de-bots that use signed minting, also check
                // the on-chain singleton directly for this specific contract
                console.log(chalk_1.default.gray(`    Also checking single-contract on-chain drop...`));
                const singleDrop = await (0, seadrop_onchain_1.fetchSingleOnChainDrop)(nftContract, 8000, chainKey);
                if (singleDrop) {
                    console.log(chalk_1.default.green(`  ✓ Found on-chain drop for this contract.`));
                    inventory.drops = [singleDrop];
                    inventory.fetchedAt = Date.now();
                    inventory.apiKeyUsed = false;
                }
            }
            if (inventory.drops.length === 0) {
                console.log(chalk_1.default.gray(`    The collection may not have any OpenSea-managed phases,`));
                console.log(chalk_1.default.gray(`    or the API key doesn't have access to them.`));
                console.log(chalk_1.default.gray(`    Try the public mint path, or check the collection page manually.\n`));
                // Don't throw — fall through to let the user proceed to public mint
                // or other paths. The FCFS wizard is one option; public mint is another.
                console.log(chalk_1.default.yellow(`  ⚠ No targetable phases. Falling through to public mint path...\n`));
                return; // exit the wizard function gracefully
            }
        }
    }
    // ── Step 1b: Try to detect the actual chain from OpenSea's response ──────
    // The public mint tool auto-detects chain by reading the contract on each
    // known RPC. For the FCFS path, OpenSea sometimes tells us the chain in the
    // drop response. If it does, and it disagrees with what the user picked,
    // warn them and offer to switch.
    if (inventory.chainId != null) {
        const reportedChain = (0, chains_1.resolveChain)(inventory.chainId);
        if (reportedChain && reportedChain.chainId !== chainProfile.chainId) {
            console.log(chalk_1.default.yellow(`\n  ⚠ OpenSea reports this collection is on ${reportedChain.name} (chain id ${reportedChain.chainId}), ` +
                `but you selected ${chainProfile.name} (chain id ${chainProfile.chainId}).`));
            console.log(chalk_1.default.gray(`    The phases listed below are from OpenSea's response.`));
            console.log(chalk_1.default.gray(`    If the chain is wrong, the mint will fail on-chain.\n`));
            // We don't auto-switch here because the user may have set up RPCs for the
            // chain they picked. But we flag it clearly.
        }
    }
    // ── Step 2: Assess eligibility for each phase ────────────────────────────
    const eligibility = (0, fcfs_drops_1.reportInventoryEligibility)(inventory, ourWallet);
    // ── Step 3: Poll current gas state ───────────────────────────────────────
    console.log(chalk_1.default.gray(`  Polling current gas state on ${chainProfile.name}...`));
    const gasState = await (0, fcfs_drops_1.fetchGasState)(rpcUrls, chainProfile.chainId, 5000);
    (0, fcfs_drops_1.printGasState)(gasState, chainProfile.name);
    // ── Step 4: Show the full inventory to the user ──────────────────────────
    (0, fcfs_drops_1.printDropsInventory)(inventory, eligibility, ourWallet, chainProfile.name);
    // ── Step 5: Check if any phase is targetable ────────────────────────────
    const targetable = eligibility.filter((e) => e.recommendation === "target");
    const needsManualCheck = eligibility.filter((e) => e.recommendation === "check-manually");
    const skip = eligibility.filter((e) => e.recommendation === "skip");
    if (targetable.length === 0) {
        console.log(chalk_1.default.yellow(`\n  ⚠ No targetable phases found.`));
        if (needsManualCheck.length > 0) {
            console.log(chalk_1.default.gray(`    Some phases exist but need manual investigation:`));
            for (const r of needsManualCheck) {
                console.log(chalk_1.default.gray(`      • ${r.drop.name || "unnamed"} — ${r.reason}`));
            }
            console.log();
        }
        if (!apiKey) {
            console.log(chalk_1.default.yellow(`  Without an OpenSea API key, signed mint data isn't available.`));
            console.log(chalk_1.default.gray(`    Get a free key and re-run to see if phases become targetable.\n`));
        }
        throw new Error(`No targetable phases for ${nftContract}. ` +
            `All ${eligibility.length} phase(s) either are skipped (${skip.length}) or need manual investigation.`);
    }
    // ── Step 6: Let the user pick a phase ────────────────────────────────────
    console.log(chalk_1.default.bold.white(`\n  ${targetable.length} targetable phase(s) found.`));
    console.log(chalk_1.default.gray(`  Enter the number of the phase to target (or press Enter for the first):`));
    for (let i = 0; i < targetable.length; i++) {
        const r = targetable[i];
        const d = r.drop;
        const startsAt = new Date(d.startTime * 1000);
        const endsAt = new Date(d.endTime * 1000);
        const isLive = Date.now() >= d.startTime * 1000 && Date.now() < d.endTime * 1000;
        const liveMark = isLive ? chalk_1.default.green("LIVE") : chalk_1.default.gray("waiting");
        console.log(chalk_1.default.gray(`    [${i + 1}] ${d.name || `phase #${i + 1}`}`));
        console.log(chalk_1.default.gray(`        type: ${d.type || "unknown"}`));
        console.log(chalk_1.default.gray(`        window: ${(0, time_format_1.toIST)(startsAt)} → ${(0, time_format_1.toIST)(endsAt)} ${liveMark}`));
        console.log(chalk_1.default.gray(`        price: ${(0, ethers_1.formatEther)(d.mintPrice)} ETH, ${d.maxTotalMintableByWallet || "unlimited"} per wallet`));
        if (r.allocationRemaining != null) {
            console.log(chalk_1.default.gray(`        allocation: ${r.allocationRemaining} slots remaining`));
        }
        console.log();
    }
    const choice = await (0, prompt_1.askText)(chalk_1.default.gray(`  Phase number (1-${targetable.length}, default 1): `));
    let selectedIndex = 0;
    if (choice && choice.trim().length > 0) {
        const parsed = parseInt(choice.trim(), 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= targetable.length) {
            selectedIndex = parsed - 1;
        }
        else {
            console.log(chalk_1.default.yellow(`  Invalid number — using first phase.`));
        }
    }
    const selected = targetable[selectedIndex];
    const selectedDrop = selected.drop;
    // ── Step 7: Fetch the signed payload for the selected phase ──────────────
    // The inventory only tells us a phase EXISTS and is targetable. To actually
    // mint, we need the per-wallet signed payload. Fetch it now.
    //
    // This step is OPTIONAL: if the signed payload can't be fetched (no key,
    // rate-limited, etc.), we show what we know and let the user decide whether
    // to skip this phase and try another, or abort.
    console.log(chalk_1.default.bold.white(`\n  Fetching signed mint data for selected phase...`));
    console.log(chalk_1.default.gray(`    Phase: ${selectedDrop.name || `phase #${selectedIndex + 1}`}`));
    console.log(chalk_1.default.gray(`    Type:  ${selectedDrop.type || "unknown"}`));
    console.log(chalk_1.default.gray(`    Drop ID: ${selectedDrop.dropId}`));
    // The inventory may have told us the mintData/mintSignature exist, but the
    // actual fetchSignedPayload call is what gets the wallet-specific
    // signature. The inventory's mintData is the generic template; the real call
    // needs to go through OpenSea's mintSigned flow.
    // Try with the key first.
    // Both slug and walletAddress are REQUIRED: fetchSignedPayload's GraphQL and
    // REST branches are gated on `slug && walletAddress`, so omitting them makes
    // both unreachable and the function falls through to the on-chain branch,
    // which only ever returns PUBLIC drops. A signed/allowlist phase therefore
    // returned null on every run — the FCFS wizard could never obtain a payload.
    // The slug is resolved from the contract when we don't already have one.
    // runFcfsBranch does not receive a slug — only a contract address — so the
    // slug must be resolved here. Without it fetchSignedPayload's GraphQL and
    // REST branches are both unreachable.
    let effectiveSlug;
    try {
        effectiveSlug = (await (0, slug_resolver_1.resolveContractToSlug)(nftContract, apiKey || "")) || undefined;
        if (effectiveSlug) {
            console.log(chalk_1.default.gray(`    Resolved slug: ${effectiveSlug}`));
        }
    }
    catch {
        effectiveSlug = undefined;
    }
    const primaryWallet = wallets[0].address;
    const payload = await (0, fcfs_mint_1.fetchSignedPayload)(nftContract, quantity, apiKey || undefined, {
        timeoutMs: 12000,
        walletAddress: primaryWallet,
        slug: effectiveSlug,
        chainKey,
    });
    if (!payload) {
        console.log(chalk_1.default.red(`\n  ✗ Could not fetch signed mint data for this phase.`));
        console.log(chalk_1.default.gray(`    Possible reasons:`));
        console.log(chalk_1.default.gray(`    • The phase exists but doesn't use OpenSea's signature flow`));
        console.log(chalk_1.default.gray(`    • The API key doesn't have access to this specific phase`));
        console.log(chalk_1.default.gray(`    • The phase requires a live session, not just an API key`));
        console.log(chalk_1.default.gray(`    • The collection isn't actually a SeaDrop collection\n`));
        if (!apiKey) {
            console.log(chalk_1.default.yellow(`  Try: get an OpenSea free API key and re-run.`));
            console.log(chalk_1.default.gray(`    Without a key, OpenSea won't return signed mint data.\n`));
        }
        // ── Optional: allow the user to skip this phase and try the next one ─────
        // Instead of throwing, offer to pick a different phase. This is important
        // for allowlist/OVR phases where the signed payload may not be available
        // without a valid key, but public mint phases might still be fireable.
        console.log(chalk_1.default.bold.white(`\n  What we know about this phase:`));
        console.log(chalk_1.default.gray(`    name:       ${selectedDrop.name || "unnamed"}`));
        console.log(chalk_1.default.gray(`    type:       ${selectedDrop.type || "unknown"}`));
        console.log(chalk_1.default.gray(`    drop ID:    ${selectedDrop.dropId}`));
        console.log(chalk_1.default.gray(`    window:     ${(0, time_format_1.toIST)(new Date(selectedDrop.startTime * 1000))} → ${(0, time_format_1.toIST)(new Date(selectedDrop.endTime * 1000))}`));
        console.log(chalk_1.default.gray(`    price:      ${(0, ethers_1.formatEther)(selectedDrop.mintPrice)} ETH`));
        console.log(chalk_1.default.gray(`    per wallet: ${selectedDrop.maxTotalMintableByWallet || "unlimited"}`));
        if (selectedDrop.gasLimit) {
            console.log(chalk_1.default.gray(`    OpenSea gas hint: ${selectedDrop.gasLimit} gas limit`));
        }
        if (selectedDrop.allowlistHash) {
            console.log(chalk_1.default.gray(`    allowlist hash: ${selectedDrop.allowlistHash.slice(0, 16)}...`));
        }
        console.log();
        // Check if there are other targetable phases we could fall back to
        const otherTargetable = eligibility.filter((e) => e.recommendation === "target" && e.drop.dropId !== selectedDrop.dropId);
        if (otherTargetable.length > 0) {
            console.log(chalk_1.default.yellow(`  Other targetable phase(s) are available — want to try one instead?`));
            const tryOther = await (0, prompt_1.askYesNo)(`  Switch to another phase?`, false);
            if (tryOther) {
                // Re-open the phase selection (jump back to Step 6 logic)
                console.log(chalk_1.default.gray(`  Re-selecting phase...\n`));
                // Recursively call the selection logic by throwing a special sentinel
                throw new Error("[SELECT_DIFFERENT_PHASE]");
            }
        }
        // No other phases to fall back to — throw the original error
        throw new Error(`Could not fetch signed mint data for phase "${selectedDrop.name || "unnamed"}". ` +
            `The phase exists but OpenSea didn't return wallet-specific signed data. ` +
            `This may require a live OAuth session, or the phase isn't using OpenSea's signature flow.`);
    }
    // ── Step 8: Show the fetched drop details ────────────────────────────────
    const drop = payload.drop;
    const startsAt = new Date(drop.startTime * 1000);
    const endsAt = new Date(drop.endTime * 1000);
    const live = Date.now() >= drop.startTime * 1000 && Date.now() < drop.endTime * 1000;
    console.log(chalk_1.default.green(`  ✓ Fetched signed mint data from OpenSea`));
    console.log(chalk_1.default.gray(`    SeaDrop:       ${payload.seaDropAddress}`));
    console.log(chalk_1.default.gray(`    NFT:           ${nftContract}`));
    console.log(chalk_1.default.gray(`    Fee recipient: ${payload.feeRecipient}`));
    console.log(chalk_1.default.gray(`    Price:         ${(0, ethers_1.formatEther)(drop.mintPrice)} × ${quantity} = ${(0, ethers_1.formatEther)(payload.value)} per wallet`));
    console.log(chalk_1.default.gray(`    Max per wallet: ${drop.maxTotalMintableByWallet || "unlimited"}`));
    console.log(chalk_1.default.gray(`    Calldata:      ${(payload.mintData.length - 2) / 2} bytes (per-wallet signed)`));
    console.log(chalk_1.default.gray(`    Window:        ${(0, time_format_1.toIST)(startsAt)} → ${(0, time_format_1.toIST)(endsAt)} ` +
        `${live ? chalk_1.default.green("(live)") : chalk_1.default.yellow(`(opens in ${(0, time_format_1.formatRemaining)(startsAt.getTime() - Date.now())})`)}`));
    if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
        throw new Error(`Requested quantity ${quantity} exceeds the per-wallet cap of ${drop.maxTotalMintableByWallet} for this phase. Reduce quantity.`);
    }
    if (Date.now() >= endsAt.getTime()) {
        console.log(chalk_1.default.yellow(`  ⚠ This stage has already ended on-chain.`));
    }
    // ── Step 9: Gas recommendation ───────────────────────────────────────────
    // Combine OpenSea-provided gas hints with live gas state for a recommendation
    const openSeaGas = selectedDrop.gasLimit
        ? {
            gasLimit: selectedDrop.gasLimit,
            maxFeePerGas: selectedDrop.maxFeePerGas,
            maxPriorityFeePerGas: selectedDrop.maxPriorityFeePerGas,
        }
        : null;
    const recommendation = (0, fcfs_drops_1.recommendGasSettings)(gasState, openSeaGas, payload.gasData?.gasLimit || 250_000);
    (0, fcfs_drops_1.printGasRecommendation)(recommendation, chainProfile.name);
    // ── Step 10: Gas selection ───────────────────────────────────────────────
    let gasLimit = recommendation.suggestedGasLimit;
    let maxFeePerGas = recommendation.suggestedMaxFeePerGasWei;
    let maxPriorityFeePerGas = recommendation.suggestedMaxPriorityFeePerGasWei;
    if (payload.gasData?.maxFeePerGas) {
        // OpenSea provided gas — use it as the baseline, but show the recommendation
        gasLimit = payload.gasData.gasLimit || gasLimit;
        maxFeePerGas = payload.gasData.maxFeePerGas;
        maxPriorityFeePerGas = payload.gasData.maxPriorityFeePerGas || BigInt(0);
        console.log(chalk_1.default.gray(`  Using OpenSea gas fields as baseline`));
    }
    else {
        // Prompt the user with the recommendation pre-filled
        console.log(chalk_1.default.bold.white(`\n  Gas settings`));
        console.log(chalk_1.default.gray(`  Recommended for current conditions:`));
        console.log(chalk_1.default.gray(`    max fee:  ${Number(maxFeePerGas) / 1e9} gwei`));
        console.log(chalk_1.default.gray(`    priority: ${Number(maxPriorityFeePerGas) / 1e9} gwei`));
        console.log(chalk_1.default.gray(`    gas limit: ${gasLimit}`));
        console.log();
        const useRecommended = await (0, prompt_1.askYesNo)(`Use recommended gas settings?`, true);
        if (!useRecommended) {
            const gas = await (0, wizard_helpers_1.promptGasGwei)(chainProfile, rpcUrls);
            maxFeePerGas = gas.maxFeePerGasWei;
            maxPriorityFeePerGas = gas.maxPriorityFeePerGasWei;
            gasLimit = gas.defaultGasLimit || 250_000;
        }
    }
    // Assess the user's choice against the recommendation
    const assessment = (0, fcfs_drops_1.gasChoiceAssessment)(maxFeePerGas, maxPriorityFeePerGas, recommendation);
    console.log(`\n${assessment.message}\n`);
    // ── Step 11: Timing ──────────────────────────────────────────────────────
    const { targetStart, timingLabel } = await (0, wizard_helpers_1.promptTiming)(startsAt);
    // ── Step 12: Balances + affordability ────────────────────────────────────
    console.log(chalk_1.default.bold.white("\nWallets"));
    const provider = new (await Promise.resolve().then(() => __importStar(require("ethers")))).JsonRpcProvider(rpcUrls[0]);
    const balances = await Promise.all(wallets.map((w) => provider.getBalance(w.address).catch(() => null)));
    const required = BigInt(gasLimit) * maxFeePerGas + payload.value;
    console.log(chalk_1.default.gray(`  Each wallet needs: ${(0, ethers_1.formatEther)(required)} ETH (gas reservation + mint value)`));
    const shortCount = wallets.filter((_, i) => balances[i] !== null && balances[i] < required).length;
    if (shortCount > 0) {
        const shortAddresses = wallets
            .filter((_, i) => balances[i] !== null && balances[i] < required)
            .map((w) => w.address);
        console.log(chalk_1.default.yellow(`  ⚠ ${shortCount} wallet(s) underfunded: ${shortAddresses.join(", ")}`));
        if (shortCount === wallets.length) {
            throw new Error("Every wallet is underfunded — nothing could be broadcast.");
        }
        console.log(chalk_1.default.yellow(`  The remaining wallet(s) can still fire.`));
    }
    // ── Step 13: Confirm ─────────────────────────────────────────────────────
    const didConfirm = await (0, wizard_helpers_1.confirmSnipe)({
        chainProfile,
        rpcUrls,
        wallets,
        balances,
        nftContract,
        quantity,
        valuePerWallet: payload.value,
        required,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        targetStart,
        timingLabel,
        modeLabel: `Allowlist / FCFS / OVR — ${selectedDrop.name || "selected phase"}`,
        targetLabel: target.label,
        promptForGas: false,
    });
    if (!didConfirm) {
        (0, prompt_1.closePrompts)();
        return;
    }
    (0, prompt_1.closePrompts)();
    const mintPlan = (0, fcfs_mint_1.buildFcfsMintPlan)(payload, gasLimit, maxFeePerGas, maxPriorityFeePerGas, quantity);
    // Pre-fetch a per-wallet payload for every wallet while the drop is still
    // future, so the T-0 path makes no API calls. Falls back to a live fetch at
    // T-0 for any wallet that returns null here.
    console.log(chalk_1.default.gray(`\n  Pre-fetching signed payloads for ${walletKeys.length} wallet(s)...`));
    const preFetched = [];
    for (let i = 0; i < walletKeys.length; i++) {
        const w = new ethers_1.Wallet(walletKeys[i]);
        try {
            const p = await (0, fcfs_mint_1.fetchSignedPayloadForWallet)(nftContract, quantity, w.address, apiKey || undefined, { timeoutMs: 15000 });
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
        nftContract,
        quantity,
        walletKeys,
        rpcUrls,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit,
        targetStart: targetStart || startsAt,
        plan: mintPlan,
        payloads: preFetched,
    });
}
// ── CLI entry: eligibility + gas check, no mint ──────────────────────────────
// Polls all phases for a contract, shows eligibility + gas state, exits.
async function runEligibilityCheck(_log, nftContract) {
    const { resolveChain } = require("./chains");
    const { fetchAllActiveDrops, reportInventoryEligibility, printDropsInventory, fetchGasState, printGasState } = require("./fcfs-drops");
    const { parseNftLink } = require("./nft-link");
    const chalk = require("chalk");
    const chainKey = (process.env.CHAIN || "base").toLowerCase();
    const chainProfile = resolveChain(chainKey);
    if (!chainProfile)
        throw new Error(`Unknown chain "${chainKey}"`);
    const envRpcs = (process.env[`RPC_URL_${chainKey.toUpperCase()}`] || "").split(",").filter(Boolean);
    const { urls: candidateRpcs } = await require("./rpc-resolver").resolveRpcsForChain(chainKey, envRpcs);
    // rpcUrls[0] is used as the read provider below, so it must be an endpoint
    // that answers eth_call. planRpcs drops wrong-chain endpoints and puts a
    // verified query-capable one first; without it a send-only sequencer can
    // land at index 0 and every read fails.
    const plan = await require("./rpc-resolver").planRpcs(candidateRpcs, chainProfile.chainId);
    const rpcUrls = plan.urls;
    if (rpcUrls.length === 0)
        throw new Error(`No usable RPC endpoints for ${chainProfile.name}`);
    const parsed = parseNftLink(nftContract);
    const lookupTarget = parsed.value;
    console.log(chalk.bold.white(`\nEligibility check for ${lookupTarget}`));
    console.log(chalk.gray(`  Chain: ${chainProfile.name} | RPC: ${rpcUrls.length} endpoint(s)`));
    const apiKey = process.env.OPENSEA_API_KEY || undefined;
    const inventory = await fetchAllActiveDrops(lookupTarget, apiKey, 12000);
    if (inventory.drops.length === 0) {
        console.log(chalk.yellow(`\n  ⚠ No active phases found for ${lookupTarget}.`));
        console.log(chalk.gray(`  Try: get an OpenSea API key, or check the collection page manually.\n`));
        return;
    }
    const ourWallet = "0x".padEnd(42, "0"); // placeholder — real wallet would be prompted
    const eligibility = reportInventoryEligibility(inventory, ourWallet);
    console.log(chalk.gray(`  Wallet: placeholder (pass keys for real check)`));
    printDropsInventory(inventory, eligibility, ourWallet, chainProfile.name);
    console.log(chalk.gray(`\n  Polling gas state on ${chainProfile.name}...`));
    const gasState = await fetchGasState(rpcUrls, chainProfile.chainId, 5000);
    printGasState(gasState, chainProfile.name);
    const targetable = eligibility.filter((e) => e.recommendation === "target");
    console.log(chalk.bold.white(`\n  Summary: ${inventory.drops.length} phase(s), ${targetable.length} targetable.`));
    if (targetable.length === 0) {
        console.log(chalk.yellow(`  ⚠ No targetable phases — nothing to mint right now.\\n`));
    }
}
async function runFcfsBranchCli(log, targetArg, opts = {}) {
    const chainKey = (opts.chain || process.env.CHAIN || "base").toLowerCase();
    const chainProfile = (0, chains_1.resolveChain)(chainKey);
    if (!chainProfile)
        throw new Error(`Unknown chain "${chainKey}"`);
    const envRpcs = (process.env[`RPC_URL_${chainKey.toUpperCase()}`] || "").split(",").filter(Boolean);
    const { urls: candidateRpcs } = await (0, rpc_resolver_1.resolveRpcsForChain)(chainKey, envRpcs);
    // rpcUrls[0] is used as the read provider for balances/eth_call, so it must be
    // an endpoint that answers those. planRpcs drops wrong-chain endpoints and
    // puts a verified query-capable one first — without it a send-only sequencer
    // can land at index 0 and every read fails. runEligibilityCheck already does
    // this; the CLI path did not, which is how a mis-ordered endpoint survived.
    const plan = await (0, rpc_resolver_1.planRpcs)(candidateRpcs, chainProfile.chainId);
    const rpcUrls = plan.urls;
    if (rpcUrls.length === 0)
        throw new Error(`No usable RPC endpoints for ${chainProfile.name}`);
    // Parse the target with the unified resolver so Scatter/Zora/direct addresses
    // work here too, not just OpenSea links.
    const parsed = (0, target_resolver_1.parseTarget)(targetArg);
    const resolvedTarget = await (0, target_resolver_1.resolveTarget)(parsed, process.env.OPENSEA_API_KEY || "", chainKey);
    if (!resolvedTarget) {
        throw new Error(parsed.platform === "manifold"
            ? `Manifold claim "${parsed.claimId}" cannot be resolved automatically — paste the 0x… claim contract instead.`
            : `Could not resolve "${targetArg}".`);
    }
    const nftContract = resolvedTarget.contract;
    const targetLabel = resolvedTarget.slug ?? resolvedTarget.contract;
    const targetChainKey = resolvedTarget.chainKey;
    const quantity = opts.quantity ?? 1;
    // ── Wallets ──────────────────────────────────────────────────────────────
    // A --wallets spec with keys in the environment means the run is headless.
    // Load them rather than prompting, which would hang forever.
    const envKeys = (0, wizard_1.loadEnvKeys)();
    let keys = [];
    if (envKeys.length > 0 && (opts.wallets || !process.stdin.isTTY)) {
        const selected = opts.wallets ? (0, wizard_1.selectFromLoaded)(envKeys, opts.wallets) : envKeys;
        keys = selected.map((w) => w.privateKey);
        console.log(chalk_1.default.bold.white("\nPrivate keys"));
        console.log(chalk_1.default.gray(`  ${keys.length} wallet(s) from environment${opts.wallets ? ` (${opts.wallets})` : ""}.`));
        for (const w of selected)
            console.log(chalk_1.default.green(`  ✓ ${w.address}`));
    }
    else {
        console.log(chalk_1.default.bold.white("\nPrivate keys"));
        console.log(chalk_1.default.gray("  Paste one key per line — typing is hidden. Blank line when done."));
        log.info("FCFS CLI: prompting for wallet keys");
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
    }
    if (keys.length === 0)
        throw new Error("No wallet keys provided.");
    console.log(chalk_1.default.gray(`  ${keys.length} wallet(s) loaded.\n`));
    log.field("wallet_count", keys.length);
    log.field("rpc_urls", rpcUrls.length);
    log.field("rpc_source", envRpcs.length > 0 ? "env" : "public");
    if (opts.at)
        log.field("scheduled_at", String((0, schedule_1.parseWhen)(opts.at)));
    if (opts.maxPrice)
        log.field("max_price", opts.maxPrice);
    log.info("FCFS CLI: keys loaded, calling runFcfsBranch");
    await runFcfsBranch(log, keys, chainProfile, targetChainKey, nftContract, quantity, rpcUrls, {
        label: targetLabel,
        at: opts.at,
        whenOpen: opts.whenOpen,
        maxPrice: opts.maxPrice,
    });
}
//# sourceMappingURL=wizard-fcfs-new.js.map