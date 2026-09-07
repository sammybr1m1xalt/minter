// Fresh verification runner — re-implements the 11 checks from the old
// .verify_result.json so we can re-verify after the slug-resolver fix.
"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = path.resolve(__dirname);
const SRC = path.join(PROJECT, "src");
const DIST = path.join(PROJECT, "dist");
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

const results = [];
let passCount = 0;

function check(label, fn) {
  try {
    const ok = fn();
    results.push({ label, passed: !!ok });
    if (ok) passCount++;
    else console.log(`FAIL: ${label}`);
  } catch (e) {
    results.push({ label, passed: false, error: String(e) });
    console.log(`FAIL: ${label} — ${e.message || e}`);
  }
}

// 1. tsc --noEmit clean
check("tsc --noEmit clean", () => {
  execSync("npx tsc --noEmit", { cwd: PROJECT, stdio: "pipe" });
  return true;
});

// 2. tsc full build
check("tsc full build", () => {
  execSync("npx tsc", { cwd: PROJECT, stdio: "pipe" });
  return true;
});

// 3. wizard.ts dotenv import+config before ethers import
check("wizard.ts dotenv import+config before ethers import", () => {
  const src = fs.readFileSync(path.join(SRC, "wizard.ts"), "utf8");
  const dotenvIdx = src.indexOf("dotenv");
  const ethersIdx = src.indexOf("ethers");
  return dotenvIdx >= 0 && ethersIdx >= 0 && dotenvIdx < ethersIdx;
});

// 4. slug-resolver.ts: REST-primary + GraphQL-fallback
check("slug-resolver.ts: REST-primary + GraphQL-fallback", () => {
  const src = fs.readFileSync(path.join(SRC, "slug-resolver.ts"), "utf8");
  const hasRest = src.includes("restCollectionBySlug") && src.includes("REST_URL");
  const hasGql = src.includes("gqlCollectionBySlug") && src.includes("GQL_URL");
  const restFirst = src.indexOf("restCollectionBySlug") < src.indexOf("gqlCollectionBySlug");
  return hasRest && hasGql && restFirst;
});

// 5. No *** placeholders in src/
check("No *** placeholders in src/", () => {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith(".ts"));
  for (const f of files) {
    const content = fs.readFileSync(path.join(SRC, f), "utf8");
    if (content.includes("***")) return false;
  }
  return true;
});

// 6. resolveContractToSlug exported from slug-resolver
check("resolveContractToSlug exported from slug-resolver", () => {
  const src = fs.readFileSync(path.join(SRC, "slug-resolver.ts"), "utf8");
  return /export\s+async\s+function\s+resolveContractToSlug/.test(src);
});

// 7. resolveContractToSlug wired into wizard phase discovery
check("resolveContractToSlug wired into wizard phase discovery", () => {
  const wizard = fs.readFileSync(path.join(SRC, "wizard.ts"), "utf8");
  const phaseSection = wizard.slice(wizard.indexOf("// ── 6b"), wizard.indexOf("// ── 7."));
  return phaseSection.includes("resolveContractToSlug");
});

// 8. e2e-test.cjs passes (27/27)
check("e2e-test.cjs passes (27/27)", () => {
  const out = execSync("node e2e-test.cjs", { cwd: PROJECT, encoding: "utf8" });
  return out.includes("ALL TESTS PASSED") && out.includes("Pass=27 Fail=0");
});

// 9. dist/index.js loads without syntax error
//    Require pure data/logic modules (no stdin, no async side-effects) so a
//    syntax error in any compiled module is caught without the wizard blocking
//    on readline. Loading several modules exercises more of the dep graph.
check("dist/index.js loads without syntax error", () => {
  const mods = [
    "chains",
    "slug-resolver",
    "nft-link",
    "time-format",
    "rpc-resolver",
    "seadrop-public",
  ];
  for (const mod of mods) {
    require(path.join(DIST, mod));
  }
  // Also require the entry point with --help wired so main() prints help and
  // returns instead of opening the interactive wizard (which would block).
  const savedArgv = process.argv;
  process.argv = ["node", "index.js", "--help"];
  try {
    require(path.join(DIST, "index"));
  } finally {
    process.argv = savedArgv;
  }
  return true;
});

// 10. wizard.ts dotenv.path uses __dirname (resolves relative to dist/)
check("wizard.ts dotenv.path uses __dirname", () => {
  const src = fs.readFileSync(path.join(SRC, "wizard.ts"), "utf8");
  return /path\.resolve\(\s*__dirname/.test(src);
});

// 11. resolveContractToSlug(nftContract, ...) in phase discovery
check("resolveContractToSlug(nftContract, ...) in phase discovery", () => {
  const wizard = fs.readFileSync(path.join(SRC, "wizard.ts"), "utf8");
  const phaseSection = wizard.slice(wizard.indexOf("// ── 6b"), wizard.indexOf("// ── 7."));
  return /resolveContractToSlug\(\s*nftContract/.test(phaseSection);
});

const failed = results.filter(r => !r.passed).map(r => r.label);
const summary = {
  timestamp: now() + " WAT",
  project_dir: PROJECT,
  total_checks: results.length,
  passed: passCount,
  failed: failed,
  checks: results,
};

fs.writeFileSync(path.join(PROJECT, ".verify_result.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`\nDone: ${passCount}/${results.length} passed, ${failed.length} failed.`);
if (failed.length) {
  console.log("Failed checks:");
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
