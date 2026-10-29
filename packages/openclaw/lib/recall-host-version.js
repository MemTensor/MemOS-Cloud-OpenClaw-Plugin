import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// Official release sources contain the provenance-restoration overwrite in
// v2026.10.2 through v2026.10.7. Real sessions_send runs verify .2 and .5.
// https://github.com/openclaw/openclaw/commit/36f630504df528ad70675238f90e4021cfcea6e0
// Do not extend this list to unknown releases without checking the host path.
const AFFECTED_OPENCLAW_RELEASES = new Set([
  "2026.10.2", "2026.10.3", "2026.10.4", "2026.10.5", "2026.10.6", "2026.10.7",
]);
const FULL_VERSION = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;

function parseVersion(value) {
  return typeof value === "string" && FULL_VERSION.test(value.trim()) ? value.trim() : null;
}

function readEntrypointPackage(entrypoint) {
  if (process.platform !== "win32" && /^[a-z]:[\\/]/i.test(entrypoint)) return null;
  let dir = dirname(entrypoint);
  for (let i = 0; i < 8; i++) {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch { /* Continue when the entrypoint has no nearby package metadata. */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function detectRecallHostVersion(api, scriptPath = process.argv[1]) {
  let resolved;
  try { resolved = realpathSync(scriptPath); } catch { /* A store path may be inspected on another platform. */ }
  const paths = [...new Set([resolved, scriptPath].filter(value => typeof value === "string" && value))];
  const packages = paths.map(readEntrypointPackage);
  if (packages.some(pkg => ["moltbot", "clawdbot"].includes(pkg?.name))) return null;
  try {
    // api.version is the plugin version. Keep the running host's full version,
    // including prerelease suffixes that the legacy hook detector discards.
    const version = parseVersion(api?.runtime?.version);
    if (version) return version;
  } catch { /* Metadata-only registration can expose a throwing runtime proxy. */ }
  for (let i = 0; i < paths.length; i++) {
    const pkg = packages[i];
    if (pkg) {
      if (pkg.name === "openclaw") return parseVersion(pkg.version);
      continue;
    }
    const normalized = paths[i].replace(/\\/g, "/");
    const match = normalized.match(/(?:^|\/)openclaw@([^/]+)\/node_modules\/openclaw(?:\/|$)/i);
    const version = parseVersion(match?.[1]);
    if (version) return version;
  }
  return null;
}

export function isRecallOverwriteAffectedHost(version) {
  const parsed = parseVersion(version);
  // Build metadata does not change release precedence; prereleases stay distinct.
  return parsed !== null && AFFECTED_OPENCLAW_RELEASES.has(parsed.split("+")[0]);
}
