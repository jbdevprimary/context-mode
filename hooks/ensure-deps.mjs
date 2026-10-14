/**
 * Shared dependency bootstrap for hooks and start.mjs.
 *
 * Single source of truth — ensures native deps (better-sqlite3) are
 * installed in the plugin cache before any hook or server code runs.
 *
 * Pattern: same as suppress-stderr.mjs — imported at the top of every
 * hook that needs native modules. Fast path: existsSync check (~0.1ms).
 * Slow path: npm install (first run only, ~5-30s).
 *
 * Also handles ABI compatibility (#148, #203): when the current Node.js
 * version differs from the one better-sqlite3 was compiled against,
 * automatically swaps in a cached binary or rebuilds. This protects
 * both the MCP server AND hooks from ABI mismatch crashes when users
 * have multiple Node versions via mise/volta/fnm/nvm.
 *
 * @see https://github.com/mksglu/context-mode/issues/148
 * @see https://github.com/mksglu/context-mode/issues/172
 * @see https://github.com/mksglu/context-mode/issues/203
 */

import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Shared 3-layer heal helper (also used by scripts/postinstall.mjs).
// Lazy-loaded via dynamic import so older installs and synthetic test
// harnesses (e.g. tests/session-hooks-smoke) — which don't ship
// `scripts/heal-better-sqlite3.mjs` — degrade to a no-op instead of
// crashing the hook with ERR_MODULE_NOT_FOUND. Best-effort posture
// matches the rest of this module.
async function healBetterSqlite3Binding(pkgRoot) {
  try {
    const helperPath = resolve(__dirname, "..", "scripts", "heal-better-sqlite3.mjs");
    if (!existsSync(helperPath)) return { healed: false, reason: "helper-missing" };
    const mod = await import(pathToFileURL(helperPath).href);
    return mod.healBetterSqlite3Binding(pkgRoot);
  } catch {
    return { healed: false, reason: "helper-error" };
  }
}

const NATIVE_DEPS = ["better-sqlite3"];
const NATIVE_BINARIES = {
  "better-sqlite3": ["build", "Release", "better_sqlite3.node"],
};
const BOOTSTRAP_LEASE = ".context-mode-native-bootstrap.lock";

function nativeBinaryPaths(pluginRoot) {
  const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
  return {
    binaryPath: resolve(nativeDir, "better_sqlite3.node"),
    abiCachePath: resolve(nativeDir, `better_sqlite3.abi${process.versions.modules}.node`),
  };
}

/**
 * Claim the cache-local dependency bootstrap lease without waiting.
 *
 * Hooks run as independent processes, so a module-level Promise cannot stop a
 * cold PostToolUse burst from launching multiple native builds. A losing hook
 * must return immediately: hooks are best-effort and the next event will see
 * the winner's completed dependency. We deliberately do not remove a lock we
 * did not create, including an old one. Automatic stale-lock deletion can
 * steal a slow install or a lock owned by a reused PID.
 */
function tryAcquireBootstrapLease(pluginRoot) {
  const path = resolve(pluginRoot, BOOTSTRAP_LEASE);
  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let fd;

  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, owner, "utf8");
    return { path, fd, owner };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    return null;
  }
}

function releaseBootstrapLease(lease) {
  try { closeSync(lease.fd); } catch { /* best effort */ }

  // Never remove a lock that has been replaced by another owner.
  try {
    if (readFileSync(lease.path, "utf8") === lease.owner) {
      unlinkSync(lease.path);
    }
  } catch { /* best effort */ }
}

/**
 * Run a native-dependency mutation once across all hook processes sharing a
 * plugin cache. Returns false to a non-owner so callers can fail open.
 */
export async function withNativeBootstrapLease(pluginRoot, bootstrap) {
  const lease = tryAcquireBootstrapLease(pluginRoot);
  if (!lease) return false;

  try {
    await bootstrap();
    return true;
  } finally {
    releaseBootstrapLease(lease);
  }
}

/**
 * Check if the current runtime has built-in SQLite support.
 * Bun has bun:sqlite, Node >= 22.5 has node:sqlite.
 *
 * Used to skip the SIGSEGV-prone child-process probe on modern Node (#331),
 * but NOT to skip installing better-sqlite3 — the bundle unconditionally
 * requires it as a fallback on non-Linux platforms (#371).
 */
function hasModernSqlite() {
  if (typeof globalThis.Bun !== "undefined") return true;
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

function nativeBootstrapAlreadyReady(pluginRoot) {
  // The modern-Node path already treats the ABI cache as a valid success
  // marker. Preserve the older-runtime probe behavior by taking the lease
  // there, rather than changing its compatibility semantics.
  if (typeof globalThis.Bun !== "undefined" || !hasModernSqlite()) return false;
  const { binaryPath, abiCachePath } = nativeBinaryPaths(pluginRoot);
  return existsSync(binaryPath) && existsSync(abiCachePath);
}

export async function ensureDeps() {
  // Bun ships bun:sqlite and never needs better-sqlite3
  if (typeof globalThis.Bun !== "undefined") return;
  for (const pkg of NATIVE_DEPS) {
    const pkgDir = resolve(root, "node_modules", pkg);
    if (!existsSync(pkgDir)) {
      // Package not installed at all
      try {
        execSync(`${process.platform === "win32" ? "npm.cmd" : "npm"} install ${pkg} --no-package-lock --no-save --silent`, {
          cwd: root,
          stdio: "pipe",
          timeout: 120000,
          shell: true,
        });
      } catch { /* best effort — hook degrades gracefully without DB */ }
    } else if (!existsSync(resolve(pkgDir, ...NATIVE_BINARIES[pkg]))) {
      // Package installed but native binary missing (e.g., npm ignore-scripts=true,
      // or Windows where `npm rebuild` falls through to node-gyp without MSVC — #408).
      // Delegate to the shared 3-layer heal (single source of truth, also used by
      // scripts/postinstall.mjs).
      try { await healBetterSqlite3Binding(root); } catch { /* helper already best-effort */ }
    }
  }
}

/**
 * Probe-load better-sqlite3 in a child process to verify the binary on disk
 * is compatible with the current Node ABI. In-process require() caches native
 * modules at the dlopen level, so it can't detect on-disk binary changes.
 * A child process gets a fresh dlopen cache.
 *
 * Note: require('better-sqlite3') only loads the JS wrapper — the native
 * binary is lazy-loaded when instantiating a Database. We must create an
 * in-memory DB to actually trigger dlopen.
 */
function probeNativeInChildProcess(pluginRoot) {
  try {
    execSync(`node -e "new (require('better-sqlite3'))(':memory:').close()"`, {
      cwd: pluginRoot,
      stdio: "pipe",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * In-process probe — cheap, safe on modern Node (no child spawn, no SIGSEGV path).
 * Returns true if better-sqlite3 loads against the current ABI.
 */
function probeNativeInProcess(pluginRoot) {
  try {
    const req = createRequire(resolve(pluginRoot, "package.json"));
    const Database = req("better-sqlite3");
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

function replaceActiveNativeBinaryFromCache(abiCachePath, binaryPath) {
  const tmpPath = `${binaryPath}.staging-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(abiCachePath, tmpPath);
    codesignBinary(tmpPath);
    renameSync(tmpPath, binaryPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    throw err;
  }
}

export function ensureNativeCompat(pluginRoot) {
  // Pre-compute paths regardless of runtime — the Bun branch below uses
  // them to seed the ABI cache (#543) so the next /ctx-upgrade boot (under
  // Node) finds the success marker file. Bun spoofs
  // process.versions.modules to match the Node ABI level (e.g. 137 on
  // Darwin matching Node 24), so a plain file-copy produces the correct
  // filename for any subsequent Node boot at the same ABI.
  const abi = process.versions.modules;
  const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
  const binaryPath = resolve(nativeDir, "better_sqlite3.node");
  const abiCachePath = resolve(nativeDir, `better_sqlite3.abi${abi}.node`);

  // Bun ships bun:sqlite — no native addon needed at RUNTIME. But
  // /ctx-upgrade still verifies the ABI cache file as the success marker,
  // so we seed it from the active binary if it exists. Best-effort:
  // any failure here is silent because Bun never loads better-sqlite3.
  if (typeof globalThis.Bun !== "undefined") {
    try {
      if (existsSync(nativeDir) && existsSync(binaryPath) && !existsSync(abiCachePath)) {
        copyFileSync(binaryPath, abiCachePath);
      }
    } catch { /* best effort — Bun never dlopens this file */ }
    return;
  }

  // On Node >= 22.5, skip the child-process probe that can cause SIGSEGV (#331).
  // The binary install/rebuild still runs — only the dlopen probe is skipped.
  const skipProbe = hasModernSqlite();

  try {
    if (!existsSync(nativeDir)) return;

    // Fast path: cached binary for this ABI already exists — swap in
    if (existsSync(abiCachePath)) {
      replaceActiveNativeBinaryFromCache(abiCachePath, binaryPath);
      if (skipProbe) return; // Trust the cached binary — skip SIGSEGV-prone probe
      // Validate via child process — dlopen cache is per-process, so in-process
      // require() can't detect a swapped binary on disk (#148)
      if (probeNativeInChildProcess(pluginRoot)) {
        return; // Cache hit validated
      }
      // Cached binary is stale/corrupt — fall through to rebuild
    }

    if (skipProbe) {
      // Seed the ABI cache from a working binary before falling back to rebuild;
      // otherwise a missing cache forces npm rebuild on every hook invocation.
      if (existsSync(binaryPath) && probeNativeInProcess(pluginRoot)) {
        copyFileSync(binaryPath, abiCachePath);
        return;
      }
      execSync(`${process.platform === "win32" ? "npm.cmd" : "npm"} rebuild better-sqlite3 --ignore-scripts=false`, {
        cwd: pluginRoot,
        stdio: "pipe",
        timeout: 60000,
        shell: true,
      });
      codesignBinary(binaryPath);
      if (existsSync(binaryPath)) {
        copyFileSync(binaryPath, abiCachePath);
      }
      return;
    }

    // Probe: try loading better-sqlite3 with current Node
    if (existsSync(binaryPath) && probeNativeInChildProcess(pluginRoot)) {
      // Load succeeded — cache the working binary for this ABI
      copyFileSync(binaryPath, abiCachePath);
    } else {
      // ABI mismatch or missing native binary — rebuild for current Node version
      execSync(`${process.platform === "win32" ? "npm.cmd" : "npm"} rebuild better-sqlite3 --ignore-scripts=false`, {
        cwd: pluginRoot,
        stdio: "pipe",
        timeout: 60000,
        shell: true,
      });
      codesignBinary(binaryPath);
      if (existsSync(binaryPath) && probeNativeInChildProcess(pluginRoot)) {
        copyFileSync(binaryPath, abiCachePath);
      }
    }
  } catch {
    /* best effort — caller will report the error on first DB access */
  }
}

/**
 * Ad-hoc codesign a native binary on macOS.
 *
 * When a cached .node binary is copied over the active one, macOS hardened
 * runtime (e.g. Zed, VS Code with runtime hardening) will SIGKILL the
 * process on the next dlopen because the code signature is invalidated.
 * SIGKILL is uncatchable — the only fix is to re-sign after the copy.
 *
 * No-op on non-macOS. Swallows errors (codesign may not be available in
 * all environments, e.g. Docker containers).
 */
export function codesignBinary(binaryPath) {
  if (process.platform === "darwin") {
    try {
      execSync(`codesign --sign - --force "${binaryPath}"`, {
        stdio: "pipe",
        timeout: 10000,
      });
    } catch { /* codesign unavailable — continue without signing */ }
  }
}

// Auto-run on import (like suppress-stderr.mjs). The lock covers both package
// installation and ABI repair: those operations mutate the same paths and
// must not race across independent hook processes.
if (!nativeBootstrapAlreadyReady(root)) {
  await withNativeBootstrapLease(root, async () => {
    // Another hook may have completed the bootstrap while this one was waiting
    // to start, so re-check only after becoming the owner.
    if (nativeBootstrapAlreadyReady(root)) return;
    await ensureDeps();
    ensureNativeCompat(root);
  });
}
