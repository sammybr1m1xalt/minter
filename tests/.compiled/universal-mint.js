"use strict";
// ── Universal mint adapter ──────────────────────────────────────────────────
//
// The problem this solves: the wizard had exactly two execution paths —
// "public" (SeaDrop mintPublic) and "signed" (OpenSea payload). Anything that
// was neither — a plain ERC721 with its own mint(), a Manifold claim, a Zora
// collect, a contract with a bespoke mint function — fell into "unknown" and
// was reported as not targettable. The user had to know which mode to flag.
//
// This module tries every adapter in order of specificity and returns the first
// plan that SIMULATES successfully. Simulation is the arbiter: a selector that
// exists but reverts (closed sale, missing proof, wrong price) is not a plan.
//
// Adapter order matters:
//   1. SeaDrop public   — the fastest path, and the one with no API dependency
//   2. SeaDrop allowlist — needs a merkle proof from the event logs
//   3. Generic registry — 61 known signatures, synthesizable args
//   4. ABI-driven       — any mint function the ABI exposes, args synthesised
//
// A contract that yields no plan from any adapter is genuinely untargettable,
// and the caller gets a reason rather than a silent failure.
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchPublicDrop = void 0;
exports.findUniversalMint = findUniversalMint;
exports.explainFailure = explainFailure;
const ethers_1 = require("ethers");
const seadrop_public_1 = require("./seadrop-public");
Object.defineProperty(exports, "fetchPublicDrop", { enumerable: true, get: function () { return seadrop_public_1.fetchPublicDrop; } });
const mint_generic_1 = require("./mint-generic");
const abi_mint_1 = require("./abi-mint");
const simulate_1 = require("./simulate");
const allowlist_onchain_1 = require("./allowlist-onchain");
/**
 * Try every mint adapter against a contract and return the first plan that
 * simulates.
 *
 * `from` is the wallet that would sign — simulation is wallet-specific for
 * allowlist and per-wallet-limit mints, so the caller must pass the real one.
 */
async function findUniversalMint(contract, provider, from, amount, opts = {}) {
    const attempts = [];
    // ── 0. Is this even a contract? ────────────────────────────────────────
    // MANDATORY. An eth_call to an EOA with arbitrary calldata SUCCEEDS — there
    // is no code to revert, so the call is treated as a plain value transfer.
    // Without this check every EOA in existence "has a mint function" and
    // simulation reports success. That is the worst possible failure mode: a
    // signed transaction to an address that cannot mint.
    try {
        const code = await provider.getCode(contract);
        if (!code || code === "0x") {
            return {
                plan: null,
                attempts: [
                    {
                        adapter: "generic-registry",
                        ok: false,
                        reason: `${contract} has no bytecode — it is an EOA or an undeployed contract, not a mintable contract`,
                    },
                ],
            };
        }
    }
    catch (e) {
        attempts.push({ adapter: "generic-registry", ok: false, reason: `eth_getCode failed: ${e?.message}` });
    }
    // ── 1. SeaDrop public ──────────────────────────────────────────────────
    // Fastest and needs no API key. Only valid when the contract has a public
    // drop configured on the SeaDrop singleton.
    //
    // buildLocalMintPlan takes an RPC URL rather than a provider, so the caller
    // must supply one. Reading it off the provider does not work: ethers v6
    // JsonRpcProvider has no `.connection.url` (that was v5), so the value comes
    // back undefined and the whole SeaDrop path silently no-ops.
    try {
        const rpcUrl = opts.rpcUrl ?? "";
        if (!rpcUrl) {
            attempts.push({
                adapter: "seadrop-public",
                ok: false,
                reason: "no RPC URL supplied (ethers v6 providers do not expose one)",
            });
        }
        else {
            const local = await (0, seadrop_public_1.buildLocalMintPlan)(rpcUrl, contract, Number(amount));
            if (!local) {
                attempts.push({ adapter: "seadrop-public", ok: false, reason: "no public drop configured" });
            }
            else {
                const sim = await (0, simulate_1.simulateTx)(provider, {
                    to: local.to,
                    from,
                    data: local.data,
                    value: local.value,
                });
                if (sim.ok) {
                    return {
                        plan: {
                            adapter: "seadrop-public",
                            to: local.to,
                            data: local.data,
                            value: local.value,
                            description: `SeaDrop mintPublic × ${amount} (${(0, ethers_1.formatEther)(local.value)} ETH)`,
                            signature: "mintPublic(address,address,address,uint256)",
                            simulated: true,
                        },
                        attempts,
                    };
                }
                attempts.push({
                    adapter: "seadrop-public",
                    ok: false,
                    reason: sim.reverted ? sim.reason ?? "reverted" : "simulation inconclusive",
                });
            }
        }
    }
    catch (e) {
        attempts.push({ adapter: "seadrop-public", ok: false, reason: e?.message ?? String(e) });
    }
    // ── 2. SeaDrop allowlist ───────────────────────────────────────────────
    // Requires a merkle proof, which we fetch from the SeaDrop event logs. Without
    // a proof this adapter cannot produce a plan — we report that distinctly
    // rather than silently skipping.
    try {
        const root = await (0, allowlist_onchain_1.getAllowlistRoot)(seadrop_public_1.SEADROP_ADDRESS, contract, provider);
        if (root) {
            const check = await (0, allowlist_onchain_1.checkAllowlist)(seadrop_public_1.SEADROP_ADDRESS, contract, from, provider, root);
            if (check.eligible && check.mintParams && check.proof) {
                attempts.push({
                    adapter: "seadrop-allowlist",
                    ok: false,
                    reason: "allowlist eligible but SeaDrop mintSigned needs an OpenSea signature — use the signed path",
                });
            }
            else {
                attempts.push({
                    adapter: "seadrop-allowlist",
                    ok: false,
                    reason: check.reason ?? "wallet not on the allowlist",
                });
            }
        }
    }
    catch {
        // Not a SeaDrop contract, or the RPC refused the range — not an error.
    }
    // ── 3. Generic registry ────────────────────────────────────────────────
    // 61 known signatures. Cheap: no ABI fetch, just selector probes.
    try {
        const generic = await (0, mint_generic_1.buildGenericMintTx)(contract, provider, from, amount, opts);
        if (generic && !generic.simulationReverted) {
            return {
                plan: {
                    adapter: "generic-registry",
                    to: generic.to,
                    data: generic.data,
                    value: generic.value,
                    description: `${generic.selector} (${(0, ethers_1.formatEther)(generic.value)} ETH)`,
                    signature: generic.selector,
                    simulated: true,
                },
                attempts,
            };
        }
        if (generic?.simulationReverted) {
            attempts.push({
                adapter: "generic-registry",
                ok: false,
                reason: `best candidate reverts: ${generic.simulationError ?? "unknown"}`,
            });
        }
        else {
            attempts.push({ adapter: "generic-registry", ok: false, reason: "no known mint signature matched" });
        }
    }
    catch (e) {
        attempts.push({ adapter: "generic-registry", ok: false, reason: e?.message ?? String(e) });
    }
    // ── 4. ABI-driven ─────────────────────────────────────────────────────
    // The catch-all: fetch the verified ABI and synthesise args for every mint-like
    // function. This is what makes an arbitrary ERC targettable.
    try {
        const network = await provider.getNetwork();
        const abiResult = await (0, abi_mint_1.fetchAbi)(Number(network.chainId), contract, {
            etherscanKey: process.env.ETHERSCAN_API_KEY || undefined,
        });
        if (abiResult?.abi) {
            const candidates = (0, abi_mint_1.deriveMintCandidates)(abiResult.abi);
            const priceInfo = await (0, abi_mint_1.readPriceFromAbi)(contract, provider, abiResult.abi, amount);
            // Try the most promising candidates first — cheapest to most expensive,
            // and free mints before paid ones.
            const ordered = orderCandidates(candidates, priceInfo?.price ?? 0n);
            for (const candidate of ordered) {
                const synth = (0, abi_mint_1.synthFromAbi)(candidate, { to: from, amount });
                if (!synth.ok || !synth.args)
                    continue;
                const probe = await (0, abi_mint_1.probeAbiCandidate)(contract, provider, candidate, synth.args, from, priceInfo?.price ?? 0n);
                if (probe.wouldSucceed) {
                    const iface = new ethers_1.Interface([
                        `function ${candidate.signature}${candidate.payable ? " payable" : ""}`,
                    ]);
                    const data = iface.encodeFunctionData(candidate.name, synth.args);
                    return {
                        plan: {
                            adapter: "abi-driven",
                            to: contract,
                            data,
                            value: priceInfo?.price ?? 0n,
                            description: `${candidate.signature} (${(0, ethers_1.formatEther)(priceInfo?.price ?? 0n)} ETH)`,
                            signature: candidate.signature,
                            simulated: true,
                        },
                        attempts,
                    };
                }
                attempts.push({
                    adapter: "abi-driven",
                    ok: false,
                    reason: `${candidate.signature}: ${probe.error ?? "reverts"}`,
                });
            }
            if (candidates.length === 0) {
                attempts.push({ adapter: "abi-driven", ok: false, reason: "ABI exposes no mint-like function" });
            }
        }
        else {
            attempts.push({
                adapter: "abi-driven",
                ok: false,
                reason: "no verified ABI available (Sourcify/Etherscan)",
            });
        }
    }
    catch (e) {
        attempts.push({ adapter: "abi-driven", ok: false, reason: e?.message ?? String(e) });
    }
    return { plan: null, attempts };
}
/**
 * Order ABI candidates: free mints first, then cheapest, then by name for
 * determinism. A free mint is the most likely to succeed and costs nothing to
 * try.
 */
function orderCandidates(candidates, _price) {
    // Prefer non-payable (free) mints, then the fewest parameters (simplest arg
    // synthesis), then by name for determinism. Price is not known per-candidate
    // until probed, so it cannot be a sort key here.
    return [...candidates].sort((a, b) => {
        if (a.payable !== b.payable)
            return a.payable ? 1 : -1;
        if (a.inputs.length !== b.inputs.length)
            return a.inputs.length - b.inputs.length;
        return a.signature.localeCompare(b.signature);
    });
}
/**
 * Human-readable summary of why a contract could not be minted. Used by the
 * wizard to explain a refusal rather than just saying "no".
 */
function explainFailure(result) {
    if (result.plan)
        return "";
    const lines = result.attempts.map((a) => `  • ${a.adapter}: ${a.reason}`);
    if (lines.length === 0)
        return "  • no mint mechanism detected";
    return lines.join("\n");
}
//# sourceMappingURL=universal-mint.js.map