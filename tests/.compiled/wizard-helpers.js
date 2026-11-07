"use strict";
// Shared wizard UI helpers — used by both the public and FCFS branches so
// we don't repeat ~80 lines of gas prompts, balance display, and the confirm
// screen in two places.
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
exports.promptGasGwei = promptGasGwei;
exports.displayBalances = displayBalances;
exports.confirmSnipe = confirmSnipe;
exports.promptTiming = promptTiming;
const chalk_1 = __importDefault(require("chalk"));
const ethers_1 = require("ethers");
const prompt_1 = require("./prompt");
const timer_1 = require("./timer");
const time_format_1 = require("./time-format");
// Thin key→value line used in the READY summary screen.
function line(label, value, color = chalk_1.default.gray) {
    console.log(color(`  ${label.padEnd(10)} ${value}`));
}
// Ask for gas (maxFee + priority) the same way in both branches.
// Returns { maxFeePerGas, maxPriorityFeePerGas } in wei.
async function promptGasGwei(chainProfile, rpcUrls, envMaxFeeOverride, envPriorityOverride) {
    const provider = new (await Promise.resolve().then(() => __importStar(require("ethers")))).JsonRpcProvider(rpcUrls[0]);
    console.log(chalk_1.default.bold.white("\nGas"));
    const envMaxFee = envMaxFeeOverride ?? Number(process.env.MAX_FEE_PER_GAS || (chainProfile.key === "ethereum" ? 80 : 2));
    const envPriority = envPriorityOverride ?? Number(process.env.MAX_PRIORITY_FEE || (chainProfile.key === "ethereum" ? 5 : 0.05));
    let baseFeeGwei = null;
    try {
        baseFeeGwei = await currentBaseFeeGwei(provider);
    }
    catch { }
    console.log(chalk_1.default.gray(`  Network base fee right now: ${(baseFeeGwei ?? 0).toFixed(6)} gwei`));
    let defaultMaxFee = envMaxFee;
    if (baseFeeGwei !== null) {
        const suggested = Math.ceil((baseFeeGwei * 2 + envPriority) * 1000) / 1000;
        if (envMaxFee < baseFeeGwei)
            defaultMaxFee = suggested;
        console.log(chalk_1.default.gray(`  Must be at least ${baseFeeGwei.toFixed(6)} gwei; ${suggested} gives room to spare.`));
    }
    const gf = await (0, prompt_1.askNumber)("Max fee per gas (gwei) — your ceiling", defaultMaxFee, { min: baseFeeGwei ?? 0 });
    const pr = await (0, prompt_1.askNumber)("Priority fee / tip (gwei)", Math.min(envPriority, gf), { min: 0, max: gf });
    const defaultGasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;
    return {
        maxFeePerGasWei: gweiToWei(gf),
        maxPriorityFeePerGasWei: gweiToWei(pr),
        defaultGasLimit,
    };
}
// Same base-fee helper, in case callers need it outside promptGasGwei.
async function currentBaseFeeGwei(provider) {
    const block = await provider.getBlock("latest");
    const baseFee = block.baseFeePerGas;
    if (!baseFee)
        return null;
    return Number(baseFee) / 1e9;
}
function gweiToWei(gwei) {
    return BigInt(Math.round(gwei * 1e9));
}
// Display balances + affordability, same in both branches.
function displayBalances(input) {
    const { wallets, balances, required } = input;
    wallets.forEach((w, i) => {
        const bal = balances[i];
        const text = bal === null ? "balance unavailable" : `${Number((0, ethers_1.formatEther)(bal)).toFixed(6)} ETH`;
        const short = bal !== null && bal < required;
        const lineText = `  [W${i}] ${w.address}  ${text}`;
        console.log(short ? chalk_1.default.red(`${lineText}  ✗ needs ${(0, ethers_1.formatEther)(input.required)}`) : chalk_1.default.gray(lineText));
    });
    const shortWallets = wallets.filter((_, i) => balances[i] !== null && balances[i] < required);
    // poorerBalance must be declared outside the if block so it's in scope for the return.
    let poorerBalance = null;
    if (shortWallets.length > 0) {
        const mintNote = input.valuePerWallet > 0n ? " + mint price" : "";
        console.log(chalk_1.default.gray(`\n  Nodes require gasLimit × maxFee${mintNote} = ${(0, ethers_1.formatEther)(input.required)} ETH held per wallet.`));
        poorerBalance = balances
            .filter((b) => b !== null)
            .reduce((a, b) => (a === null || b < a ? b : a), null);
        const requiredWithoutMint = required - input.valuePerWallet;
        const affordable = poorerBalance !== null && requiredWithoutMint > 0n
            ? Number(requiredWithoutMint / BigInt(input.gasLimit)) / 1e9
            : null;
        if (affordable !== null && affordable > 0) {
            console.log(chalk_1.default.yellow(`  Either fund the wallets, or re-run with a max fee at or below ${affordable.toFixed(4)} gwei.`));
        }
        if (shortWallets.length === wallets.length) {
            throw new Error("Every wallet is underfunded — nothing could be broadcast.");
        }
        console.log(chalk_1.default.yellow("  The remaining wallet(s) can still fire."));
    }
    return { shortCount: shortWallets.length, poorerBalance: poorerBalance };
}
// Print the READY summary and wait for user confirmation.
// Throws / returns false if the user aborts.
async function confirmSnipe(input) {
    console.log(chalk_1.default.bold.white("\n──────── READY ────────"));
    line("Mode", input.modeLabel);
    line("Chain", `${input.chainProfile.name} (${input.chainProfile.chainId})`);
    line("RPC", `${labelOf(input.rpcUrls[0])} + ${input.rpcUrls.length - 1} more`);
    line("Target", input.targetLabel);
    line("Contract", input.nftContract);
    line("Wallets", `${input.wallets.length}`);
    line("Quantity", `${input.quantity} per wallet → ${input.quantity * input.wallets.length} total`);
    line("Mint cost", `${(0, ethers_1.formatEther)(input.valuePerWallet)} per wallet → ${(0, ethers_1.formatEther)(input.valuePerWallet * BigInt(input.wallets.length))} total (+ gas)`);
    if (input.promptForGas) {
        line("Gas", `${input.gasLimit} gas · maxFee unknown until prompted`);
    }
    else {
        line("Gas", `${input.gasLimit} gas · ${(0, ethers_1.formatEther)(input.maxFeePerGas)} max · ${(0, ethers_1.formatEther)(input.maxPriorityFeePerGas)} tip`);
    }
    line("Timing", input.timingLabel);
    console.log(chalk_1.default.bold.white("───────────────────────"));
    if (!(await (0, prompt_1.askYesNo)(chalk_1.default.bold("Fire?"), false))) {
        console.log(chalk_1.default.yellow("\n  Aborted — nothing was sent.\n"));
        return false;
    }
    return true;
}
async function promptTiming(dropStartTime) {
    // If the drop start time is unknown, skip timing entirely.
    if (!dropStartTime) {
        return { targetStart: null, timingLabel: "No start time known — fire when ready" };
    }
    const delay = dropStartTime.getTime() - Date.now();
    if (delay <= 0) {
        return { targetStart: dropStartTime, timingLabel: "Stage already open" };
    }
    const waitStr = `in ${Math.round(delay / 1000)}s`;
    console.log(chalk_1.default.bold.white(`\nTiming`));
    console.log(chalk_1.default.gray(`  Stage opens ${(0, time_format_1.toIST)(dropStartTime)} (${waitStr} from now)`));
    await (0, timer_1.waitForMintTime)(dropStartTime);
    return { targetStart: dropStartTime, timingLabel: `Fires at ${(0, time_format_1.toIST)(dropStartTime)}` };
}
function labelOf(url) {
    try {
        return new URL(url).hostname;
    }
    catch {
        return url;
    }
}
//# sourceMappingURL=wizard-helpers.js.map