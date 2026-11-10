// Chain registry — everything chain-specific lives here so adding a new
// network is a single entry instead of hunting for hardcoded values.
//
// `key` is the identifier used in three places, and they must match:
//   1. the OpenSea GraphQL `chain` field (opensea-api.ts)
//   2. the `--chain` CLI option
//   3. the `CHAIN` env var
//
// OpenSea confirmed support for Robinhood Chain (opensea.io/discover/chain/robinhood),
// so the existing OpenSea-based mint flow works on it unchanged — only the RPC
// (in .env) and the explorer links (resolved here) differ from Base.

import { JsonRpcProvider } from "ethers";

export interface ChainProfile {
  key: string;          // OpenSea id + --chain value + CHAIN env value
  chainId: number;      // EVM network chain id
  name: string;         // human label
  explorer: string;     // block explorer base URL, NO trailing slash
  nativeSymbol: string;
  rpc: {
    alchemyHost?: string; // Alchemy host for this network (docs/reference)
    public: string[];     // public RPC + sequencer endpoints
  };
}

export const CHAINS: ChainProfile[] = [
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "eth-mainnet.g.alchemy.com",
      public: [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.merkle.io",
        "https://cloudflare-eth.com",
      ],
    },
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    explorer: "https://basescan.org",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "base-mainnet.g.alchemy.com",
      public: [
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
        // Send-only (rejects eth_chainId/eth_call) but the fastest inclusion
        // path — planRpcs keeps it for blasting and never reads from it.
        "https://mainnet-sequencer.base.org",
      ],
    },
  },
  {
    key: "robinhood",
    chainId: 4663,
    name: "Robinhood Chain",
    explorer: "https://robinhoodchain.blockscout.com",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "robinhood-mainnet.g.alchemy.com",
      public: [
        "https://rpc.mainnet.chain.robinhood.com",
        "https://sequencer.mainnet.chain.robinhood.com",
      ],
    },
  },
  {
    // Arc Chain (Circle) — verified live 2026-11-08: chain id 5042 (0x13b2),
    // USDC is the native gas token, sub-second finality.
    // Public endpoints answered eth_chainId anonymously with no API key.
    key: "arc",
    chainId: 5042,
    name: "Arc",
    explorer: "https://explorer.arc.io",
    nativeSymbol: "USDC",
    rpc: {
      alchemyHost: "arc-mainnet.g.alchemy.com",
      public: [
        "https://rpc.mainnet.arc.io",
        "https://rpc.drpc.mainnet.arc.io",
      ],
    },
  },
  {
    // Soneium mainnet — verified live 2026-11-08: chain id 1868 (0x74c), ETH
    // gas, SeaDrop singleton deployed at the same address as every other chain
    // (eth_getCode returned bytecode). OpenSea lists it as "soneium" in
    // /api/v2/chains, explorer https://soneium.blockscout.com.
    // All three endpoints below answered eth_chainId anonymously.
    // NOTE: Etherscan V2 does NOT support chainid 1868, so ABI-driven minting on
    // Soneium depends on Sourcify alone (abi-mint tries Etherscan first only
    // when a key is set, then falls through to Sourcify).
    key: "soneium",
    chainId: 1868,
    name: "Soneium",
    explorer: "https://soneium.blockscout.com",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "soneium-mainnet.g.alchemy.com",
      public: [
        "https://rpc.soneium.org",
        "https://soneium-rpc.publicnode.com",
        "https://soneium.drpc.org",
      ],
    },
  },
];


// Fallback explorer for chains not in CHAINS. Basescan is used because it is
// the most common non-Ethereum explorer in this set; unknown chains still get
// a working (if possibly wrong) link rather than a broken one.
const DEFAULT_EXPLORER = "https://basescan.org";

// Resolve a chain by its numeric chainId (from the live network) or by its
// string key (--chain / CHAIN). Returns undefined for unknown chains.
export function resolveChain(
  idOrKey: string | number | bigint | null | undefined
): ChainProfile | undefined {
  if (idOrKey === null || idOrKey === undefined) return undefined;
  if (typeof idOrKey === "string") {
    const key = idOrKey.trim().toLowerCase();
    return CHAINS.find((c) => c.key === key);
  }
  const id = Number(idOrKey);
  return CHAINS.find((c) => c.chainId === id);
}

/** Convert a numeric chain id to our internal chain key. */
export function chainKeyFromId(chainId: number): string | null {
  const c = resolveChain(chainId);
  return c?.key ?? null;
}

// ── Provider cache ──────────────────────────────────────────────────────────
//
// A fresh JsonRpcProvider at every call site leaks one: every provider carries
// a polling timer, so each leaked one keeps the Node event loop busy and the
// process never exits.
//
// A cached provider is also faster: the first request pays the connection
// setup, and every later call reuses the keep-alive socket.

const providerCache = new Map<string, JsonRpcProvider>();

// Per-chain request timeout so a stalled RPC never hangs a mint or a poll.
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS) || 15000;

/**
 * Get a cached provider for a chain, creating it on first use.
 *
 * The caller does NOT own the returned provider — it is shared and must not be
 * destroyed. Use `shortLivedProvider` for a one-off read that must not leak.
 */
export function getProvider(idOrKey: string | number | bigint): JsonRpcProvider {
  const profile = resolveChain(idOrKey);
  if (!profile) {
    throw new Error(`unknown chain: ${String(idOrKey)}`);
  }
  const cached = providerCache.get(profile.key);
  if (cached) return cached;

  const url = profile.rpc.public[0];
  const provider = new JsonRpcProvider(url, profile.chainId, {
    staticNetwork: true,
    pollingInterval: 4000,
  });
  providerCache.set(profile.key, provider);
  return provider;
}

/**
 * Create a provider for a specific RPC URL.
 *
 * Use this for one-off reads (simulation, eth_getCode, a gas estimate) where a
 * cached per-chain provider is not wanted. The caller owns the result and MUST
 * call destroy() when finished — see the note on provider lifetime in
 * simulate.ts.
 */
export function shortLivedProvider(
  rpcUrl: string,
  chainId?: number
): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: true,
    pollingInterval: 1000,
  });
}

/** Destroy every cached provider. Call before process exit. */
export function destroyProviderCache(): void {
  for (const p of providerCache.values()) {
    try {
      p.destroy();
    } catch {
      // Already destroyed.
    }
  }
  providerCache.clear();
}

export { RPC_TIMEOUT_MS };

// ── OpenSea chain key mapping ────────────────────────────────────────────────
// Maps our internal chain keys to OpenSea's chain identifiers.
// Verified against the live /api/v2/chains list (2026-11-05), which is
// authoritative over the docs' ChainIdentifier enum (the docs list 26 and are
// missing arc, which the live API returns).
// Unknown keys pass through unchanged.
const OS_CHAIN: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  polygon: "polygon",   // live API uses "polygon"; the old "matic" is stale
  arbitrum: "arbitrum",
  optimism: "optimism",
  "zora-network": "zora",
  avalanche: "avalanche",
  robinhood: "robinhood",
  arc: "arc",
  soneium: "soneium",
};

/** Convert our internal chain key to OpenSea's GraphQL chain identifier. */
export function osChain(chainKey: string): string {
  return OS_CHAIN[chainKey] || chainKey;
}

// Build a block-explorer tx URL for whatever chain we're on. Accepts either the
// numeric chainId (preferred — it's authoritative) or the string key. Falls back
// to Basescan for unknown chains so links are never broken silently.
export function explorerTx(
  idOrKey: string | number | bigint | null | undefined,
  txHash: string
): string {
  const profile = resolveChain(idOrKey);
  const base = profile?.explorer ?? DEFAULT_EXPLORER;
  return `${base}/tx/${txHash}`;
}
