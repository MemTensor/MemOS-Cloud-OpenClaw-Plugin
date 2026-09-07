import { cp, lstat, mkdir, rmdir, rm, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptsDir, "..");
const coreDist = resolve(packageDir, "..", "core", "dist");
const target = resolve(packageDir, "lib", "memos-core");
const workspaceCoreLink = resolve(
  packageDir,
  "node_modules",
  "@memtensor",
  "memos-cloud-plugin-core",
);

const removeEmptyDirectory = async (path) => {
  try {
    await rmdir(path);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
};

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(coreDist, target, { recursive: true });

// The runtime imports the copied core above, not the pnpm workspace package.
// Leaving pnpm's external workspace junction in the plugin directory causes
// OpenClaw's local-path safety scan to reject both linked and copied installs.
try {
  const stat = await lstat(workspaceCoreLink);
  if (!stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-link workspace dependency: ${workspaceCoreLink}`);
  }
  await unlink(workspaceCoreLink);
  await removeEmptyDirectory(dirname(workspaceCoreLink));
  await removeEmptyDirectory(resolve(packageDir, "node_modules"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
