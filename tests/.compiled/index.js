#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const chalk_1 = __importDefault(require("chalk"));
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), ".env") });
const logger_1 = require("./logger");
const wizard_1 = require("./wizard");
const prompt_1 = require("./prompt");
const schedule_1 = require("./schedule");
const price_protection_1 = require("./price-protection");
const HELP = `\nNFT Mint Sniper\n\n  Mints public SeaDrop stages AND FCFS/allowlist/OVR stages, plus any\n  contract with a discoverable mint function (ERC721/ERC1155, Manifold,\n  Zora, Scatter, or a bespoke mint).\n  Public mints need no OpenSea account; FCFS stages fetch a signed\n  payload from OpenSea (free API key, auto-managed).\n\nUsage\n  npm start                          run the interactive wizard\n  npm start -- --fcfs <target>       run the FCFS/allowlist/OVR branch directly\n  npm start -- --eligibility <ca>   poll eligibility + gas for a contract (no mint)\n  npm start -- --help                show this message\n\nTarget\n  An OpenSea / Scatter / Zora / Manifold link, a collection slug, or a contract\n  address. Chain aliases work: "0xabc… on base", "slug matic", "slug arb".\n\nOptions\n  --at <time>           ISO 8601, unix seconds/ms, "in 5m", "30s", or "HH:MM"\n  --max-price <price>   max total price in ETH, "free", "0.05/unit", "0.05total",\n                        or "any" (no cap)\n  --wallets <spec>      all | N | 1,3,4  (default: single primary wallet)\n  --chain <key>         ethereum | base | polygon | arbitrum | optimism | ...\n  --quantity <n>        NFTs per wallet (default 1)\n\nExamples\n  npm start -- --fcfs de-bots\n  npm start -- --fcfs de-bots --at "in 5m" --max-price 0.01\n  npm start -- --eligibility 0x8d80efb61341e4b8459fbb52b213d5c25a1af179\n  npm start -- --fcfs 0xabc… on base --quantity 3 --wallets all\n\nEverything not passed as a flag is asked interactively: keys, chain, quantity,\nNFT link, RPC, gas and timing. Optional defaults can be set in .env.\n`;
function parseFlags(argv) {
    const out = {
        fcfs: null,
        eligibility: null,
        at: null,
        whenOpen: false,
        maxPrice: null,
        wallets: null,
        chain: null,
        quantity: null,
        rest: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--fcfs")
            out.fcfs = argv[++i] ?? null;
        else if (a === "--eligibility")
            out.eligibility = argv[++i] ?? null;
        else if (a === "--at")
            out.at = argv[++i] ?? null;
        else if (a === "--when-open" || a === "--open")
            out.whenOpen = true;
        else if (a === "--max-price" || a === "--maxprice" || a === "-p")
            out.maxPrice = argv[++i] ?? null;
        else if (a.startsWith("--max-price=") || a.startsWith("--maxprice=")) {
            out.maxPrice = a.split("=")[1];
        }
        else if (a === "--wallets" || a === "-w")
            out.wallets = argv[++i] ?? null;
        else if (a === "--chain")
            out.chain = argv[++i] ?? null;
        else if (a === "--quantity" || a === "-q") {
            const n = Number(argv[++i]);
            out.quantity = Number.isInteger(n) && n > 0 ? n : null;
        }
        else
            out.rest.push(a);
    }
    return out;
}
/** Validate the flags that can be checked without touching the network. */
function validateFlags(flags) {
    if (flags.at && !(0, schedule_1.isValidWhen)(flags.at)) {
        return `--at "${flags.at}" is not a recognised time. Use ISO 8601, unix seconds/ms, "in 5m", "30s", or "HH:MM".`;
    }
    if (flags.maxPrice) {
        try {
            (0, price_protection_1.parsePriceSpec)(flags.maxPrice);
        }
        catch (e) {
            return `--max-price "${flags.maxPrice}" is not a recognised price. Use an ETH amount, "free", or "any".`;
        }
    }
    if (flags.quantity != null && flags.quantity < 1) {
        return `--quantity must be at least 1.`;
    }
    return null;
}
async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        console.log(HELP);
        return;
    }
    const flags = parseFlags(args);
    const err = validateFlags(flags);
    if (err) {
        console.error(chalk_1.default.red(`\n❌ ${err}\n`));
        process.exit(1);
    }
    // A target can be given positionally or after --fcfs. Prefer the flag.
    const fcfsTarget = flags.fcfs ?? (flags.rest.length > 0 ? flags.rest.join(" ") : null);
    // ── FCFS branch ──────────────────────────────────────────────────────────
    if (fcfsTarget) {
        const log = (0, logger_1.createRunLogger)({ mode: "fcfs", label: fcfsTarget });
        log.field("target", fcfsTarget);
        log.field("chain_env", process.env.CHAIN || "<unset>");
        log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
        log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");
        if (flags.at)
            log.field("scheduled_at", String((0, schedule_1.parseWhen)(flags.at)));
        if (flags.maxPrice)
            log.field("max_price", flags.maxPrice);
        if (flags.wallets)
            log.field("wallets", flags.wallets);
        if (flags.quantity != null)
            log.field("quantity", flags.quantity);
        try {
            log.info("Calling runFcfsBranchCli...");
            await (0, wizard_1.runFcfsBranchCli)(log, fcfsTarget, {
                at: flags.at,
                whenOpen: flags.whenOpen,
                maxPrice: flags.maxPrice,
                wallets: flags.wallets,
                chain: flags.chain,
                quantity: flags.quantity,
            });
            log.info("FCFS branch completed successfully");
            log.end();
            (0, prompt_1.closePrompts)();
            process.exit(0);
        }
        catch (e) {
            log.dumpError(e);
            log.end();
            (0, prompt_1.closePrompts)();
            console.error(chalk_1.default.red(`\n❌ ${e.message}\n`));
            process.exit(1);
        }
    }
    // ── Eligibility check ────────────────────────────────────────────────────
    if (flags.eligibility) {
        const targetArg = flags.eligibility;
        const log = (0, logger_1.createRunLogger)({ mode: "eligibility", label: targetArg });
        log.field("target", targetArg);
        log.field("chain_env", process.env.CHAIN || "<unset>");
        log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
        try {
            log.info("Calling runEligibilityCheck...");
            await (0, wizard_1.runEligibilityCheck)(log, targetArg);
            log.info("Eligibility check completed");
            log.end();
            (0, prompt_1.closePrompts)();
            process.exit(0);
        }
        catch (e) {
            log.dumpError(e, { phase: "runEligibilityCheck", target: targetArg });
            log.end();
            (0, prompt_1.closePrompts)();
            console.error(chalk_1.default.red(`\n❌ ${e.message}\n`));
            process.exit(1);
        }
    }
    // ── Interactive wizard (default) ─────────────────────────────────────────
    const log = (0, logger_1.createRunLogger)({ mode: "wizard", label: "interactive" });
    log.field("chain_env", process.env.CHAIN || "<unset>");
    log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
    log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");
    if (flags.at)
        log.field("scheduled_at", String((0, schedule_1.parseWhen)(flags.at)));
    if (flags.maxPrice)
        log.field("max_price", flags.maxPrice);
    log.info("Starting interactive wizard");
    try {
        await (0, wizard_1.runWizard)(log, {
            at: flags.at,
            whenOpen: flags.whenOpen,
            maxPrice: flags.maxPrice,
            wallets: flags.wallets,
            chain: flags.chain,
            quantity: flags.quantity,
            target: flags.rest.length > 0 ? flags.rest.join(" ") : null,
        });
        log.info("Wizard completed successfully");
        log.end();
        (0, prompt_1.closePrompts)();
        process.exit(0);
    }
    catch (e) {
        log.dumpError(e);
        log.end();
        (0, prompt_1.closePrompts)();
        console.error(chalk_1.default.red(`\n❌ ${e.message}\n`));
        process.exit(1);
    }
}
void main();
//# sourceMappingURL=index.js.map