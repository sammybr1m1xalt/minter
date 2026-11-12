// ── Session storage ──────────────────────────────────────────────────────────
// One home for the on-disk session paths. The legacy single-session file and the
// per-wallet SIWE jar are both OpenSea logins; resolving their directory in two
// modules is how they drift apart.

import path from "path";

let cachedDir: string | null = null;

/**
 * Directory holding the minter's OpenSea session files.
 *
 * Everything the minter stores lives inside the project, never in the user's
 * home directory. The package root is the directory holding package.json
 * (dist/.. once compiled), so the cache follows the install rather than the
 * machine — and clearing ~/.nft-public-mint cannot invalidate a working setup.
 */
export function sessionDir(): string {
  if (cachedDir) return cachedDir;
  const explicit = process.env.OPENSEA_SESSION_DIR?.trim();
  if (explicit) {
    cachedDir = explicit;
    return cachedDir;
  }
  const d = path.join(path.resolve(__dirname, ".."), ".minter-session");
  try {
    require("fs").mkdirSync(d, { recursive: true, mode: 0o700 });
  } catch {}
  cachedDir = d;
  return cachedDir;
}

/** The legacy single-session file: one accessToken/refreshToken pair. */
export function legacySessionFile(): string {
  return `${sessionDir()}/opensea_session.json`;
}

/** Per-wallet SIWE cookie jars, keyed by lowercased address. */
export function siweSessionsFile(): string {
  return `${sessionDir()}/opensea_sessions.json`;
}

/** A session cached by an older build under the user's home directory. Read once. */
export function legacyHomeSessionFile(): string {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".nft-public-mint", "opensea_session.json") : "";
}
