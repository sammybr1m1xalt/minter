// `--scan <url>` — find the collection contract on any site.
//
// Not boxed to OpenSea: it fetches the page, pulls every address-shaped string
// out of the HTML, the inline scripts and the linked bundles, and ranks them by
// where they were found. The ranking is deliberately not volume-based — a
// contract that has not minted yet has no volume, so that signal would be
// useless here.
//
// Output is a ranked list with the evidence, not a verdict. The scanner reports
// what the site says; verifying it on-chain is a separate step.
import chalk from "chalk";
import { scanUrl, scanWithBundles, type AddressCandidate } from "./site-scanner";

function parseArgs(args: string[]): { url: string | null; timeoutMs: number; bundles: boolean } {
  let url: string | null = null;
  let timeoutMs = 15_000;
  let bundles = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--timeout") timeoutMs = Number(args[++i] ?? 15000) || 15000;
    else if (a === "--no-bundles") bundles = false;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: minter --scan <url> [--timeout ms] [--no-bundles]

Fetches the page, extracts every address-shaped string from the HTML, inline
scripts and linked bundles, and ranks them by where they were found.`);
      process.exit(0);
    } else if (!a.startsWith("--") && !url) {
      url = a;
    }
  }
  return { url, timeoutMs, bundles };
}

const SOURCE_LABEL: Record<AddressCandidate["source"], string> = {
  "contracts-block": "contracts block (strongest)",
  "json-key": "JSON key",
  "script-blob": "script bundle",
  "mint-button": "mint button",
  "html-text": "page text (weakest)",
};

export async function runScanCli(args: string[]): Promise<number> {
  const { url, timeoutMs, bundles } = parseArgs(args);
  if (!url) {
    console.error(chalk.red("\n❌ scan needs a url: minter --scan <url>\n"));
    return 2;
  }

  console.log(chalk.gray(`\n  scanning ${url} (bundles ${bundles ? "on" : "off"}, ${timeoutMs}ms timeout)\n`));

  const started = Date.now();
  const result =
    bundles && typeof scanWithBundles === "function"
      ? await scanWithBundles(url, timeoutMs).catch(() => null)
      : await scanUrl(url, timeoutMs);
  const elapsed = Date.now() - started;

  if (!result) {
    console.log(chalk.yellow("  No result — the page did not answer, timed out, or was not HTML."));
    console.log();
    return 1;
  }

  console.log(chalk.gray(`  ${result.totalFound} distinct address(es), ${result.candidates.length} ranked, ${elapsed}ms`));
  console.log();

  if (result.empty) {
    console.log(chalk.yellow("  Nothing found. A bot wall or consent page still returns 200 with HTML,"));
    console.log(chalk.yellow("  so this means the page had no address-shaped strings — not that it is clean."));
    console.log();
    return 1;
  }

  const top = result.candidates.slice(0, 10);
  top.forEach((c, i) => {
    const strong = c.score >= 70;
    const line = `  ${String(i + 1).padStart(2)}. ${c.address}  score ${String(c.score).padStart(3)}  ${SOURCE_LABEL[c.source]}`;
    console.log(strong ? chalk.green(line) : chalk.gray(line));
    const detail: string[] = [`seen ${c.occurrences}x`];
    if (c.key) detail.push(`key "${c.key}"`);
    console.log(chalk.gray(`      ${detail.join("  ·  ")}`));
  });

  if (result.candidates.length > top.length) {
    console.log(chalk.gray(`\n  …and ${result.candidates.length - top.length} more`));
  }

  console.log();
  console.log(chalk.gray("  A high score is evidence, not proof. Verify the contract on-chain before minting."));
  console.log();
  return 0;
}
