"use strict";
// Minimal interactive prompt layer built on node:readline — no extra deps.
//
// Menus are numbered rather than arrow-key driven on purpose: a sniper gets
// driven under time pressure, often over SSH, and typing "2 <enter>" works
// identically in every terminal (including Windows Terminal / PowerShell)
// without any raw-mode key handling to get wrong.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.closePrompts = closePrompts;
exports.ask = ask;
exports.askHidden = askHidden;
exports.askChoice = askChoice;
exports.askNumber = askNumber;
exports.askText = askText;
exports.askYesNo = askYesNo;
const readline_1 = __importDefault(require("readline"));
const chalk_1 = __importDefault(require("chalk"));
let rl = null;
let shuttingDown = false;
// Lines are queued as they arrive rather than read via rl.question(), which
// only captures the *next* line emitted after it is called. A piped stdin emits
// every line at once, so anything not currently being awaited would be dropped
// and the wizard would stall on question two.
const queue = [];
let waiter = null;
// Terminal mode only when stdin really is a TTY. Forcing it on makes readline
// treat a redirected stdin as raw keystrokes — the whole buffer echoes at once.
const isTty = Boolean(process.stdin.isTTY);
function getRl() {
    if (!rl) {
        rl = readline_1.default.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: isTty,
        });
        rl.on("line", (line) => {
            if (waiter) {
                const resolve = waiter;
                waiter = null;
                resolve(line);
            }
            else {
                queue.push(line);
            }
        });
        // Ctrl+C, Ctrl+D, or piped input running out mid-question. Without this the
        // pending question never resolves and the process just dies quietly.
        rl.on("close", () => {
            if (waiter && !shuttingDown) {
                console.log(chalk_1.default.yellow("\n  Input closed — aborting. Nothing was sent.\n"));
                process.exit(130);
            }
        });
    }
    return rl;
}
// Release stdin. Call this before firing so readline never competes with the
// blast logging (or holds the event loop open at exit).
function closePrompts() {
    shuttingDown = true;
    if (rl) {
        rl.close();
        rl = null;
    }
}
function readLine() {
    getRl();
    const queued = queue.shift();
    if (queued !== undefined)
        return Promise.resolve(queued);
    return new Promise((resolve) => {
        waiter = resolve;
    });
}
async function ask(prompt, fallback = "") {
    process.stdout.write(prompt);
    const answer = (await readLine()).trim();
    // A TTY echoes what was typed and moves the cursor down on Enter; a pipe does
    // neither, which runs every prompt together into one unreadable line. Echo it
    // ourselves so scripted runs leave a transcript you can actually audit.
    if (!isTty)
        process.stdout.write(`${answer}\n`);
    return answer.length > 0 ? answer : fallback;
}
// Read a line without echoing it. In a TTY we mute readline's redraw entirely —
// muting selectively would leak the typed text, since every redraw string
// contains both the prompt and the input. Outside a TTY readline never echoes.
async function askHidden(prompt) {
    process.stdout.write(prompt);
    if (!isTty) {
        const answer = await readLine();
        process.stdout.write("\n"); // never echo the key itself
        return answer.trim();
    }
    const r = getRl();
    const original = r._writeToOutput;
    r._writeToOutput = () => { };
    try {
        return (await readLine()).trim();
    }
    finally {
        r._writeToOutput = original;
        process.stdout.write("\n");
    }
}
async function askChoice(title, choices, defaultIndex = 0) {
    console.log(chalk_1.default.bold.white(`\n${title}`));
    choices.forEach((c, i) => {
        const hint = c.hint ? chalk_1.default.gray(`  — ${c.hint}`) : "";
        console.log(`    ${chalk_1.default.bold.cyan(`${i + 1})`)} ${c.label}${hint}`);
    });
    for (;;) {
        const raw = await ask(chalk_1.default.gray(`  › choose 1-${choices.length} [${defaultIndex + 1}]: `), String(defaultIndex + 1));
        const idx = parseInt(raw, 10) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < choices.length) {
            console.log(chalk_1.default.green(`  ✓ ${choices[idx].label}`));
            return choices[idx].value;
        }
        console.log(chalk_1.default.red(`  ✗ Enter a number between 1 and ${choices.length}.`));
    }
}
async function askNumber(question, fallback, opts = {}) {
    const { min = -Infinity, max = Infinity } = opts;
    for (;;) {
        const raw = await ask(chalk_1.default.gray(`  › ${question} [${fallback}]: `), String(fallback));
        const n = Number(raw);
        if (Number.isFinite(n) && n >= min && n <= max)
            return n;
        console.log(chalk_1.default.red(`  ✗ Enter a number${min > -Infinity ? ` ≥ ${min}` : ""}${max < Infinity ? ` and ≤ ${max}` : ""}.`));
    }
}
async function askText(question, fallback = "") {
    const suffix = fallback ? ` [${fallback}]` : "";
    return ask(chalk_1.default.gray(`  › ${question}${suffix}: `), fallback);
}
async function askYesNo(question, defaultYes = false) {
    const hint = defaultYes ? "Y/n" : "y/N";
    for (;;) {
        const raw = (await ask(chalk_1.default.gray(`  › ${question} (${hint}): `), defaultYes ? "y" : "n")).toLowerCase();
        if (raw === "y" || raw === "yes")
            return true;
        if (raw === "n" || raw === "no")
            return false;
        console.log(chalk_1.default.red("  ✗ Answer y or n."));
    }
}
//# sourceMappingURL=prompt.js.map