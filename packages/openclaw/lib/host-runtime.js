import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const HOST_IDS = new Set(["openclaw", "moltbot", "clawdbot"]);
// Hook availability follows the numeric release, including development builds.
const HOST_VERSION = /^(\d+\.\d+(?:\.\d+)?)(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;

function parseHostVersion(value) {
  const version = typeof value === "string" ? HOST_VERSION.exec(value.trim())?.[1] ?? null : null;
  // OpenClaw's version resolver uses 0.0.0 when build metadata is missing.
  return version === "0.0.0" ? null : version;
}

export function readHostRuntimeVersion(api) {
  try {
    // api.version describes this plugin; runtime.version belongs to the host.
    return parseHostVersion(api?.runtime?.version);
  } catch {
    // Metadata-only registration can expose a runtime proxy that throws.
    return null;
  }
}

function hostIdFromPath(value) {
  const path = String(value || "").replace(/\\/g, "/").toLowerCase();
  const entry = path.match(/(?:^|\/)(openclaw|moltbot|clawdbot)(?:\.(?:mjs|cjs|js|exe|cmd|ps1))?$/);
  if (entry) return entry[1];
  const packages = [...path.matchAll(/(?:^|\/)node_modules\/(openclaw|moltbot|clawdbot)(?=\/|$)/g)];
  return packages.at(-1)?.[1] ?? null;
}

function hostVersionFromPath(value, hostId) {
  const path = String(value || "").replace(/\\/g, "/");
  const packages = [...path.matchAll(/(?:^|\/)(openclaw|moltbot|clawdbot)@(\d+\.\d+(?:\.\d+)?)(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?(?=[/_]|$)/gi)];
  return parseHostVersion(packages.findLast((match) => match[1].toLowerCase() === hostId)?.[2]);
}

function readHostPackage(entrypoint) {
  let dir = dirname(entrypoint);
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      // A wrapper or inspection harness owns its own version. Do not attribute
      // that version (or a more distant parent package) to the host CLI.
      if (!HOST_IDS.has(pkg.name)) return null;
      return {
        id: pkg.name,
        version: parseHostVersion(pkg.version),
      };
    } catch {
      // The entrypoint may be a bundle or an unresolved global-install path.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function detectHostRuntime({ scriptPath = process.argv[1], execPath = process.execPath } = {}) {
  const entrypoint = String(scriptPath || "");
  let resolvedEntrypoint;
  try {
    resolvedEntrypoint = realpathSync(entrypoint);
  } catch {
    // Path-based detection also supports hosts inspected on another platform.
  }

  const paths = [...new Set([resolvedEntrypoint, entrypoint].filter(Boolean))];
  for (const path of paths) {
    const host = readHostPackage(path);
    if (host) {
      // A symlink target can retain its package name without version metadata.
      // Keep its identity, but also inspect the original entrypoint for a version.
      const version = host.version ?? paths
        .map((candidate) => hostVersionFromPath(candidate, host.id))
        .find(Boolean) ?? null;
      return { ...host, version };
    }
  }

  // Match CLI filenames or actual node_modules package segments, never arbitrary
  // usernames or parent directories containing an old product name.
  const id = paths.map(hostIdFromPath).find(Boolean) || hostIdFromPath(execPath) || "openclaw";
  const version = paths.map((path) => hostVersionFromPath(path, id)).find(Boolean) ?? null;
  return { id, version };
}
