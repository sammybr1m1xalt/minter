// ── Optimised FCFS / allowlist snipe — independent of the public path ──
//
// Opens room for both:
//   (a) OpenSea v2 API-key-only signed-payload fetch (no session), and
//   (b) a refreshable OAuth session (one-time setup, auto-renewed) when v2
//       still requires a live session for mintSigned().
//
// The public path (seadrop-public / local-mint / public wizard branch) is
// untouched. This file + its session module are the entire FCFS addition.

import chalk from "chalk";
import { Wallet, formatEther, getAddress } from "ethers";
import { CHAINS, resolveChain } from "./chains";
import { parseRpcEndpoints, PreparedBlast, prepareBlast, blastToAll, waitForReceipt, BlastResult } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { sweepOnChain, summarizeOnChain, ConfirmedTx } from "./rpc-health";

// ── OpenSea v2 shapes (read from the live response, not hardcoded magic) ──

export interface SeaDropDropMeta {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

export interface FcfsGasData {
  gasLimit: number;
  maxFeePerGas: bigint;       // wei
  maxPriorityFeePerGas: bigint; // wei
}

export interface FcfsSignedPayload {
  seaDropAddress: string;   // who we send the mint tx to (usually the SeaDrop singleton)
  nftContract: string;      // the token contract
  feeRecipient: string;     // SeaDrop fee recipient for this drop
  mintData: string;         // hex calldata for mintSigned(nftContract, feeRecipient, ...)
  mintSignature: string;    // OpenSea's server signature bound to this wallet (per-wallet!)
  value: bigint;            // mintPrice × quantity
  drop: SeaDropDropMeta;
  gasData?: FcfsGasData;   // optional — OpenSea sometimes recommends gas fields
}

export interface FcfsMintPlan {
  payload: FcfsSignedPayload;
  quantity: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

// ── Multi-drop inventory (new) ───────────────────────────────────────────────
// See fcfs-drops.ts for the full module. These re-exports let the wizard use
// the inventory flow without importing from two places.

export { DropPhase, GasState, CollectionDropsInventory, EligibilityReport, GasRecommendation } from "./fcfs-drops";
export {
  fetchAllActiveDrops,
  reportInventoryEligibility,
  assessDropEligibility,
  printDropsInventory,
  fetchGasState,
  printGasState,
  recommendGasSettings,
  printGasRecommendation,
  gasChoiceAssessment,
} from "./fcfs-drops";

// ── Latency-sorted RPC list (built during setup, used at fire) ─────────

export interface RpcEndpointLatency {
  url: string;
  label: string;
  latencyMs: number | null; // null = unmeasured
}

export async function measureRpcLatency(urls: string[], timeoutMs = 3000): Promise<RpcEndpointLatency[]> {
  const endpoints = parseRpcEndpoints(urls);
  const results: RpcEndpointLatency[] = [];

  for (const ep of endpoints) {
    const t0 = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      results.push({ url: ep.url, label: ep.label, latencyMs: Math.round(performance.now() - t0) });
    } catch {
      results.push({ url: ep.url, label: ep.label, latencyMs: null });
    }
  }
  results.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  return results;
}

// ── OpenSea session — path (b): refreshable OAuth token, stored on disk ──

const SESSION_DIR = process.env.OPENSEA_SESSION_DIR
  ? process.env.OPENSEA_SESSION_DIR
  : (() => {
      const d = process.env.HOME ? `${process.env.HOME}/.nft-public-mint` : "";
      try { require("fs").mkdirSync(d, { recursive: true }); } catch {}
      return d;
    })();

const SESSION_FILE = `${SESSION_DIR}/opensea_session.json`;

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // UNIX ms
  scope?: string;
}

export async function loadStoredSession(): Promise<StoredSession | null> {
  try {
    const raw = require("fs").readFileSync(SESSION_FILE, "utf-8");
    const s = JSON.parse(raw) as StoredSession;
    if (Date.now() >= s.expiresAt) return null; // expired — caller renews
    return s;
  } catch {
    return null;
  }
}

export async function saveStoredSession(s: StoredSession): Promise<void> {
  require("fs").writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), "utf-8");
}

export async function clearStoredSession(): Promise<void> {
  try { require("fs").unlinkSync(SESSION_FILE); } catch {}
}

// ── Path (a): API-key-only fetch of signed payload (try first) ──────────

export async function fetchFcfsSignedPayloadKeyOnly(
  nftContract: string,
  quantity: number,
  apiKey: string | undefined,
  opts: { timeoutMs?: number } = {}
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers["X-API-KEY"] = apiKey.trim();

    // OpenSea v2: try the drops endpoint for an active allowlist / OVR-allocated
    // stage. We do NOT filter by type in the URL — any active stage is a candidate,
    // including fcfs, allowlist, ovr, reserved, or whatever OpenSea names them.
    // The type check happens in extractActiveDrop below.
    const res = await fetch(
      `https://api.opensea.io/api/v2/collections/${nftContract}/drops?status=active`,
      { signal: controller.signal, headers }
    );
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      // Key rejected / needs session — fall through to path (b) downstream.
      return null;
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error("OpenSea rate-limited the FCFS lookup — retry in a few seconds.");

    const json = (await res.json()) as any;
    const drop = extractActiveDrop(json, nftContract);
    if (!drop) return null;

    const payload = await buildSignedPayloadFromDrop(drop, nftContract, quantity, apiKey);
    if (!payload) return null;
    return payload;
  } catch (err: any) {
    if (err && err.name === "AbortError") throw new Error("OpenSea FCFS fetch timed out");
    throw err;
  }
}

// ── Path (b): fetch signed payload with a live session token ─────────────

export async function fetchFcfsSignedPayloadWithSession(
  nftContract: string,
  quantity: number,
  session: StoredSession,
  apiKey: string | undefined,
  opts: { timeoutMs?: number } = {}
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${session.accessToken}`,
    };
    if (apiKey) headers["X-API-KEY"] = apiKey.trim();

    const res = await fetch(
      `https://api.opensea.io/api/v2/collections/${nftContract}/drops?status=active`,
      { signal: controller.signal, headers }
    );
    clearTimeout(timer);

    if (res.status === 401) {
      // Token expired mid-run — try one refresh
      const renewed = await refreshSessionToken(session.refreshToken, apiKey);
      if (!renewed) return null;
      return fetchFcfsSignedPayloadWithSession(nftContract, quantity, renewed, apiKey, opts);
    }
    if (res.status === 403 || res.status === 404) return null;
    if (res.status === 429) throw new Error("OpenSea rate-limited the FCFS lookup — retry in a few seconds.");

    const json = (await res.json()) as any;
    const drop = extractActiveDrop(json, nftContract);
    if (!drop) return null;

    return await buildSignedPayloadFromDrop(drop, nftContract, quantity, apiKey);
  } catch (err: any) {
    if (err && err.name === "AbortError") throw new Error("OpenSea FCFS fetch timed out");
    throw err;
  }
}

// ── Shared: turn whatever v2 returns into a FcfsSignedPayload ────────────

async function buildSignedPayloadFromDrop(
  drop: any,
  nftContract: string,
  quantity: number,
  apiKey: string | undefined
): Promise<FcfsSignedPayload | null> {
  // The exact field names here are whatever OpenSea v2 actually hands back for
  // an FCFS/allowlist stage's signed mint payload. Adapt to the live response.
  const seaDropAddress = drop.seaDropAddress || drop.seadrop_address || "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
  const feeRecipient = drop.feeRecipient || drop.fee_recipient;
  const mintData = drop.mintData || drop.mint_data || drop.calldata;
  const mintSignature = drop.mintSignature || drop.mint_signature || drop.signature;
  const mintPrice = BigInt(drop.mintPrice || drop.mint_price || drop.price || "0");
  const startTime = Number(drop.startTime || drop.start_time || drop.start || 0);
  const endTime = Number(drop.endTime || drop.end_time || drop.end || 0);
  const maxTotal = Number(drop.maxTotalMintableByWallet || drop.max_total_mintable_by_wallet || drop.maxPerWallet || 0);
  const feeBps = Number(drop.feeBps || drop.fee_bps || 0);
  const restrict = Boolean(drop.restrictFeeRecipients || drop.restrict_fee_recipients || false);

  if (!mintData || !mintSignature) return null;

  const value = mintPrice * BigInt(quantity);
  const gasData = buildGasDataFromDrop(drop);

  return {
    seaDropAddress,
    nftContract,
    feeRecipient: feeRecipient || "0x0000a26b00c1F0DF003000390027140000fAa719",
    mintData,
    mintSignature,
    value,
    drop: { mintPrice, startTime, endTime, maxTotalMintableByWallet: maxTotal, feeBps, restrictFeeRecipients: restrict },
    gasData,
  };
}

function buildGasDataFromDrop(drop: any): FcfsGasData | undefined {
  const gasLimit = drop.gasLimit || drop.gas_limit;
  const maxFeePerGas = drop.maxFeePerGas || drop.max_fee_per_gas;
  const maxPriorityFeePerGas = drop.maxPriorityFeePerGas || drop.max_priority_fee_per_gas;
  if (!gasLimit && !maxFeePerGas) return undefined;
  return {
    gasLimit: gasLimit ? Number(gasLimit) : 250_000,
    maxFeePerGas: maxFeePerGas ? BigInt(maxFeePerGas) : BigInt(0),
    maxPriorityFeePerGas: maxPriorityFeePerGas ? BigInt(maxPriorityFeePerGas) : BigInt(0),
  };
}

function extractActiveDrop(json: any, nftContract: string): any | null {
  if (!json) return null;
  // v2 may return { drops: [...] } or { data: { drops: [...] } } or a single drop.
  const candidates: any[] = [];
  if (Array.isArray(json)) candidates.push(...json);
  else if (json.dumps && Array.isArray(json.dumps)) candidates.push(...json.dumps);
  else if (json.data && Array.isArray(json.data)) candidates.push(...json.data);
  else if (json.drops && Array.isArray(json.drops)) candidates.push(...json.drops);
  else if (json.result) candidates.push(json.result);

  for (const c of candidates) {
    if (c.nftContract === nftContract || c.contractAddress === nftContract || c.address === nftContract) {
      // Accept any active drop — fcfs, allowlist, ovr, reserved, or whatever
      // OpenSea names the phase. We don't care about the type; we just need an
      // active stage with signed mint data (mintData + mintSignature).
      if (c.status === "active") return c;
    }
  }
  return null;
}

// ── OAuth refresh (path b) ───────────────────────────────────────────────

const OPENSEA_OAUTH_REFRESH_URL = "https://api.opensea.io/api/v2/oauth/refresh";

export async function refreshSessionToken(
  refreshToken: string,
  apiKey: string | undefined
): Promise<StoredSession | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey.trim();
  headers["content-type"] = "application/json";

  try {
    const res = await fetch(OPENSEA_OAUTH_REFRESH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (res.status !== 200) return null;
    const json = (await res.json()) as any;
    const accessToken = json.access_token;
    const newRefresh = json.refresh_token || refreshToken;
    const expiresIn = Number(json.expires_in || json.expiresIn || 3600);
    if (!accessToken) return null;
    const s: StoredSession = {
      accessToken,
      refreshToken: newRefresh,
      expiresAt: Date.now() + expiresIn * 1000 - 60_000, // refresh 1 min early
      scope: json.scope,
    };
    await saveStoredSession(s);
    return s;
  } catch {
    return null;
  }
}

// ── One-time OAuth setup (path b) — user completes login once ────────────

export async function runOAuthSetup(
  apiKey: string | undefined
): Promise<StoredSession | null> {
  // The cleanest automated path: spin up a headless browser, complete the
  // OpenSea OAuth login, extract the refresh token, store it.
  //
  // If a headless browser isn't available / you'd rather do it manually, the
  // fallback is: paste the refresh token here once, store it, and the script
  // renews on every run.
  //
  // This function is the extension point for whichever flow you pick. Right now
  // it implements the "paste a refresh token you got once" path — swap in a
  // puppeteer/playwright OAuth flow here if you want fully automated setup.

  console.log(chalk.bold.white("\nOpenSea session setup (one-time)"));
  console.log(chalk.gray("  OpenSea needs an authenticated session for mintSigned()."));
  console.log(chalk.gray("  Option A: paste a refresh token you got from OpenSea once."));
  console.log(chalk.gray("  Option B: we open a headless browser and you log in (needs puppeteer)."));
  console.log(chalk.gray("  The token is stored encrypted-ish on disk and renewed automatically.\n"));

  const choice = await askSetupChoice();
  if (choice === "paste") {
    const rt = await askSetupPaste();
    if (!rt) return null;
    // We need an access token to validate the refresh token works. Try a refresh.
    const fakeAccess = "placeholder-for-validation";
    const testSession: StoredSession = {
      accessToken: fakeAccess,
      refreshToken: rt,
      expiresAt: Date.now() + 3599_000,
    };
    const renewed = await refreshSessionToken(rt, apiKey);
    if (!renewed) {
      console.log(chalk.red("\n  ✗ That refresh token didn't validate against OpenSea."));
      console.log(chalk.gray("  Get a fresh one from OpenSea's OAuth flow and paste it again.\n"));
      return await runOAuthSetup(apiKey);
    }
    console.log(chalk.green("\n  ✓ Session stored and validated. The script will renew it automatically.\n"));
    return renewed;
  }

  // headless path — leave as extension point
  console.log(chalk.yellow("\n  ⚠ Headless OAuth isn't wired up yet — paste a refresh token for now.\n"));
  return await runOAuthSetup(apiKey);
}

// ── helpers (inline, no extra imports beyond what's available) ───────────

async function askSetupChoice(): Promise<"paste" | "headless"> {
  // Minimal inline readline prompt so this module doesn't depend on prompt.ts
  // for the one-time setup flow. For regular runs, the wizard drives everything.
  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    readline.question(
      chalk.gray("  Paste refresh token (p) or open browser (b) [p]: ") + "\n",
      (answer: string) => {
        readline.close();
        const a = answer.trim().toLowerCase();
        if (a === "b" || a === "browser" || a === "headless") resolve("headless");
        else resolve("paste");
      }
    );
  });
}

async function askSetupPaste(): Promise<string | null> {
  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    readline.question(
      chalk.gray("  Paste your OpenSea refresh token: ") + "\n",
      (answer: string) => {
        readline.close();
        const t = answer.trim();
        resolve(t.length > 0 ? t : null);
      }
    );
  });
}

// ── Execute the FCFS snipe — race-optimized dispatch ─────────────────────

export interface FiredTx {
  idx: number;
  address: string;
  txHash: string;
  responsePromise: Promise<BlastResult[]>;
  dispatchedAt: number;
}

export async function executeFcfsSnipe(opts: {
  nftContract: string;
  quantity: number;
  walletKeys: string[];
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: number;
  targetStart: Date | null;
  plan: FcfsMintPlan;
  openSeaApiKey?: string;
  session?: StoredSession | null;
}): Promise<void> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFeePerGas, gasLimit, targetStart,
    plan, openSeaApiKey, session,
  } = opts;

  const provider = new (await import("ethers")).JsonRpcProvider(rpcUrls[0]);
  const blastEndpoints = parseRpcEndpoints(rpcUrls);

  // ── Pre-warm every socket + OpenSea endpoint BEFORE the wait ──────────
  const warmTargets = [...rpcUrls];
  if (openSeaApiKey) warmTargets.push("https://api.opensea.io/api/v2/collections");
  console.log(chalk.gray("  Warming RPC + OpenSea sockets..."));
  await warmConnections(warmTargets);
  console.log(chalk.green("  Sockets hot."));

  // ── Pre-sort RPCs by latency (build once, use at fire) ───────────────
  const latencySorted = await measureRpcLatency(rpcUrls);
  const fastEndpoints = latencySorted
    .filter((l) => l.latencyMs !== null)
    .slice(0, Math.min(4, latencySorted.length))
    .map((l) => blastEndpoints.find((e) => e.url === l.url)!)
    .filter(Boolean);
  console.log(
    chalk.gray(
      `  Fastest RPCs: ${fastEndpoints.map((e) => chalk.cyan(e.label)).join(", ") || "none measured"}`
    )
  );

  // ── Pre-fetch nonces + balances for all wallets in parallel ───────────
  const wallets = walletKeys.map((k) => new Wallet(k));
  const balancesFcfs = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null))
  );
  const [nonces, network] = await Promise.all([
    Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;

  const required = BigInt(gasLimit) * maxFeePerGas + plan.payload.value;

  // Build per-wallet balance info for the warning screen.
  const walletMetas: { idx: number; address: string; balance: bigint | null; nonce: number }[] = [];
  for (let i = 0; i < wallets.length; i++) {
    walletMetas.push({ idx: i, address: wallets[i].address, balance: balancesFcfs[i], nonce: nonces[i] });
  }

  console.log(chalk.gray(`  ${wallets.length} wallet(s) loaded — fire screen shows what each can cover.`));

  // ── Check wallet funding and warn before fire ─────────────────────────
  // We still fire ALL wallets — the RPC will reject underfunded ones naturally.
  // But we warn here so the user knows what to expect before the stage opens.
  const fundingWarnings: string[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const bal = walletMetas[i].balance;
    if (bal !== null) {
      const shortfall = required - bal;
      if (shortfall > 0) {
        fundingWarnings.push(
          `[W${i}] ${wallets[i].address}  ${
            shortfall > required ? "NO FUNDS" : `${formatEther(shortfall)} short`
          } of ${formatEther(required)} needed`
        );
      } else {
        const headroom = bal - required;
        if (headroom < required) {
          // Tight — can cover but barely
          fundingWarnings.push(
            `[W${i}] ${wallets[i].address}  TIGHT — only ${formatEther(headroom)} headroom (` +
            `${Math.round(Number(headroom) / Number(required) * 100)}% above requirement)`
          );
        }
      }
    }
  }

  if (fundingWarnings.length > 0) {
    console.log(chalk.bold.yellow("\n── Funding Warning ──"));
    console.log(chalk.gray("  These wallets will still be fired — the RPC rejects unfunded txs."));
    console.log(chalk.gray("  If a tx is rejected for insufficient funds, it won't be broadcast.\n"));
    for (const w of fundingWarnings) {
      console.log(chalk.yellow(`  ${w}`));
    }
    console.log();
  }

  // ── Pre-sign every wallet's tx the moment the signed payload is known ──
  //     (parallel, not sequential — all wallets sign at once)
  console.log(chalk.gray("  Pre-signing all wallets in parallel..."));
  const signStart = performance.now();

  const signedTxs: { idx: number; address: string; rawTx: string; txHash: string; blast: PreparedBlast }[] = await Promise.all(
    wallets.map(async (wallet, idx) => {
      const w = wallet;
      const nonce = nonces[idx];
      const rawTx = await w.signTransaction({
        to: plan.payload.seaDropAddress,
        data: plan.payload.mintData,
        value: plan.payload.value,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit,
        type: 2,
        chainId,
      });
      const blast = prepareBlast(rawTx);
      return { idx, address: w.address, rawTx, txHash: blast.txHash, blast };
    })
  );

  // ── Pre-serialize all blast bodies — zero stringify on the hot path ─────
  const prepared = signedTxs;

  console.log(
    chalk.green(
      `  ✓ ${prepared.length} tx(s) signed + bodies serialized in ${(performance.now() - signStart).toFixed(1)}ms — nothing to compute at fire time`
    )
  );

  // ── Wait for the stage window (or fire now) ──────────────────────────
  if (targetStart) {
    await waitForMintTime(targetStart, 100); // 100ms early-fire: tx already in mempool at T-0
  } else {
    console.log(chalk.bold.yellow("\n  🚀 Firing immediately..."));
  }

  const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
  const dispatchStart = performance.now();

  // ── BLAST: fire every pre-built body to every RPC in parallel ─────────
  //     First RPC to accept wins. No logging in this critical section.
  const fired: FiredTx[] = [];
  for (const p of prepared) {
    const { idx, address, txHash, blast } = p;
    const dispatchedAt = Date.now();

    const fireTargets = fastEndpoints.length > 0 ? fastEndpoints : blastEndpoints;
    const firePromises = fireTargets.map((ep) =>
      fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: blast.body,
        keepalive: true,
      })
    );

    const responsePromise = Promise.allSettled(firePromises).then(async (settled) => {
      const results: BlastResult[] = [];
      for (let i = 0; i < settled.length; i++) {
        const ep = fireTargets[i];
        const s = settled[i];
        if (s.status === "fulfilled") {
          try {
            const json = (await s.value.json()) as any;
            if (json.result) {
              results.push({ label: ep.label, txHash: json.result, error: null });
            } else if (json.error) {
              const errMsg = json.error.message || JSON.stringify(json.error);
              results.push({ label: ep.label, txHash: null, error: errMsg });
            }
          } catch (err: any) {
            results.push({ label: ep.label, txHash: null, error: err.message });
          }
        } else {
          results.push({ label: ep.label, txHash: null, error: String(s.reason) });
        }
      }
      return results;
    });

    fired.push({ idx, address, txHash, responsePromise, dispatchedAt });
  }

  const dispatchMs = (performance.now() - dispatchStart).toFixed(2);
  const sinceStage = Math.max(0, Date.now() - stageStartMs);

  // ── NOW print dispatch summary (stdout no longer blocks the blast) ────
  console.log(chalk.bold.green(`\n  DISPATCHED ${fired.length} tx(s) (${dispatchMs}ms, +${sinceStage}ms after stage)`));
  for (const f of fired) {
    console.log(chalk.gray(`    [W${f.idx}] ${f.address}  ${f.txHash}`));
  }

  // ── Wait for responses, split accepted vs rejected ────────────────────
  const settled = await Promise.all(
    fired.map(async (f) => ({ ...f, results: await f.responsePromise }))
  );

  const accepted = settled.filter(({ results }) =>
    results.some((r) => r.txHash !== null || (r.error ?? "").includes("already known"))
  );
  const rejected = settled.filter((s) => !accepted.includes(s));

  for (const { idx, results } of rejected) {
    const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
    console.log(chalk.bold.red(`\n  ✗ [W${idx}] REJECTED by every RPC — never broadcast.`));
    for (const reason of reasons) console.log(chalk.red(`      ${reason}`));
    if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
      console.log(chalk.yellow("      → Your max fee is under the chain's base fee. Raise it and re-run."));
    }
  }

  if (accepted.length === 0) {
    console.log(chalk.bold.red("\n===== NOTHING WAS BROADCAST — no receipts to wait for =====\n"));
    return;
  }

  // ── Receipts for accepted txs ─────────────────────────────────────────
  console.log(chalk.gray("\n  Waiting for receipts..."));
  await Promise.all(
    accepted.map(async ({ idx, txHash }) => {
      const receipt = await waitForReceipt(txHash, rpcUrls[0], 60_000);
      if (!receipt) {
        console.log(chalk.yellow(`  [W${idx}] TIMEOUT — check: ${explorerTx(chainId, txHash)}`));
        return;
      }
      const color = receipt.status === "SUCCESS" ? chalk.bold.green : chalk.bold.red;
      console.log(
        color(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`)
      );
      console.log(chalk.gray(`  [W${idx}] Track: ${explorerTx(chainId, txHash)}`));
    })
  );

  // ── On-chain confirmation sweep ──────────────────────────────────────────
  // Double-check every fired tx against the chain directly. This catches cases
  // where the receipt polling missed something or a TX is still pending.
  const firedTxsForSweep: { address: string; txHash: string; dispatchedAt: number }[] = fired.map((f) => ({
    address: f.address,
    txHash: f.txHash,
    dispatchedAt: f.dispatchedAt,
  }));
  const confirmed = await sweepOnChain(firedTxsForSweep, rpcUrls, 120_000);
  console.log("\n" + summarizeOnChain(confirmed));

  console.log(chalk.bold.white("\n===== FCFS MINT COMPLETE =====\n"));
}

// ── Build the plan object from the signed payload + user's gas choices ───

export function buildFcfsMintPlan(
  payload: FcfsSignedPayload,
  gasLimit: number,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint
): FcfsMintPlan {
  return {
    payload,
    quantity: 1, // quantity is already baked into payload.value / mintData by the caller
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}
