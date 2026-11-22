// ── Supply-position wait ────────────────────────────────────────────────────
// Token ids are handed out in order, so the minted supply at the moment of
// inclusion is the only thing that decides which ids a mint receives. This is
// shared by the signed (fcfs) and local (public calldata) fire paths — both
// mint sequentially, so the same position maths applies to both.
import chalk from "chalk";
import { Interface, JsonRpcProvider } from "ethers";
import { withDeadlineOrThrow } from "./deadline";

const SUPPLY_IFACE = new Interface(["function totalSupply() view returns (uint256)"]);

/** Hold the fire until the minted supply reaches `tokenId - quantity`. */
export interface SupplyPosition {
  tokenId: number;
  quantity: number;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Read the minted supply from the NFT contract, walking the endpoint list.
 * null means "could not tell" — never zero.
 */
export async function readMintedSupply(
  nftContract: string,
  chainId: number,
  rpcUrls: string[],
  timeoutMs: number
): Promise<bigint | null> {
  const data = SUPPLY_IFACE.encodeFunctionData("totalSupply()");
  for (const url of rpcUrls) {
    const provider = new JsonRpcProvider(url, chainId, { staticNetwork: true, pollingInterval: 4000 });
    try {
      const raw = await withDeadlineOrThrow(
        provider.call({ to: nftContract, data }),
        timeoutMs,
        "totalSupply"
      );
      const [value] = SUPPLY_IFACE.decodeFunctionResult("totalSupply()", raw);
      return value as bigint;
    } catch {
      // Try the next endpoint.
    } finally {
      try {
        provider.destroy();
      } catch {
        // Already destroyed.
      }
    }
  }
  return null;
}

/**
 * Hold until the supply reaches `tokenId - quantity`, so the mint starts at the
 * position that lands on `tokenId`. Bounded; fires anyway on timeout, because a
 * mint at the wrong position is still a mint while a refusal loses it.
 */
export async function waitForSupplyPosition(
  opts: SupplyPosition,
  ctx: { nftContract: string; chainId: number; rpcUrls: string[] }
): Promise<void> {
  if (!(opts.tokenId >= 1) || !(opts.quantity >= 1)) {
    console.log(
      chalk.yellow(
        `  ⚠ fireOnSupplyReached ignored: tokenId ${opts.tokenId} and quantity ${opts.quantity} must both be >= 1.`
      )
    );
    return;
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = Math.max(100, opts.pollMs ?? 250);
  // The mint must START at tokenId - quantity + 1, so the supply before it must
  // be exactly tokenId - quantity.
  const threshold = BigInt(Math.max(0, opts.tokenId - opts.quantity));
  const deadline = Date.now() + timeoutMs;
  console.log(
    chalk.gray(
      `  Holding for supply ${threshold} — lands token ${opts.tokenId} at quantity ${opts.quantity} (budget ${timeoutMs / 1000}s)...`
    )
  );
  let last: bigint | null = null;
  for (;;) {
    const budget = Math.min(5000, Math.max(500, deadline - Date.now()));
    const supply = await readMintedSupply(ctx.nftContract, ctx.chainId, ctx.rpcUrls, budget);
    if (supply != null) last = supply;
    if (supply != null && supply >= threshold) {
      console.log(chalk.green(`  Supply ${supply} reached — firing.`));
      return;
    }
    if (Date.now() >= deadline) {
      console.log(
        chalk.yellow(
          `  ⚠ Supply position not reached in ${timeoutMs / 1000}s (last ${last ?? "unknown"}) — firing at the current position anyway.`
        )
      );
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
