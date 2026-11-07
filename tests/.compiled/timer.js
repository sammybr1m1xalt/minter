"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForMintTime = waitForMintTime;
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
async function waitForMintTime(mintTime, earlyFireMs = 0) {
    // Fire early by earlyFireMs — tx sits in mempool and lands the moment contract allows.
    // WARNING: earlyFireMs only helps if your RPC is on the same chain the contract
    // cares about. If rpcUrls[0] resolves to the wrong chain (e.g. Base RPC while
    // the contract is on Ethereum), the tx will be rejected or silently misdirected.
    // Run rpcHealthCheck() before relying on earlyFireMs.
    const fireTime = new Date(mintTime.getTime() - earlyFireMs);
    const now = new Date();
    const diff = fireTime.getTime() - now.getTime();
    if (diff <= 0) {
        console.log(chalk_1.default.yellow("  Fire time already passed — sending immediately."));
        return;
    }
    console.log(chalk_1.default.bold.white(`\n⏰ Mint time: ${mintTime.toISOString()}`));
    if (earlyFireMs > 0) {
        console.log(chalk_1.default.bold.yellow(`  🔥 Early fire: ${earlyFireMs}ms before mint → firing at ${fireTime.toISOString()}`));
    }
    console.log(chalk_1.default.gray(`  Now: ${now.toISOString()} | Waiting ${Math.ceil(diff / 1000)}s...\n`));
    // If more than 10 seconds away, show a countdown spinner
    if (diff > 10000) {
        const spinner = (0, ora_1.default)({
            text: formatCountdown(fireTime),
            color: "cyan",
        }).start();
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                const remaining = fireTime.getTime() - Date.now();
                if (remaining <= 5000) {
                    clearInterval(interval);
                    spinner.stop();
                    resolve();
                }
                else {
                    spinner.text = formatCountdown(fireTime);
                }
            }, 500);
        });
    }
    // Precise wait for the last few seconds using a tight loop
    const remaining = fireTime.getTime() - Date.now();
    if (remaining > 0) {
        if (remaining > 100) {
            await new Promise((resolve) => setTimeout(resolve, remaining - 100));
        }
        // Tight spin-wait for the final milliseconds
        while (Date.now() < fireTime.getTime()) {
            // Spin-wait — burns CPU but gives sub-ms precision
        }
    }
    console.log(chalk_1.default.bold.green("  🟢 FIRING!\n"));
}
function formatCountdown(target) {
    const diff = target.getTime() - Date.now();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    if (hours > 0) {
        return `  Waiting... ${hours}h ${minutes}m ${seconds}s remaining`;
    }
    if (minutes > 0) {
        return `  Waiting... ${minutes}m ${seconds}s remaining`;
    }
    return `  Waiting... ${seconds}s remaining`;
}
//# sourceMappingURL=timer.js.map