import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { waitForNpmReleaseVisibility } from '../.github/scripts/wait-for-npm-release.mjs'
import { packPackage } from './pack-package.mjs'
import { repositoryRoot, runChecked, runPnpm } from './command-runtime.mjs'

const gitSafeDirectory = (root) => root.replaceAll('\\', '/')
const git = (root, args, options = {}) => runChecked(
  'git',
  ['-c', `safe.directory=${gitSafeDirectory(root)}`, ...args],
  { cwd: root, ...options },
)

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

export const captureVersionFileSnapshots = (definition, root) => definition.versionFiles.map((relativePath) => ({
  relativePath,
  contents: readFileSync(resolve(root, relativePath)),
}))

export const restoreVersionFileSnapshots = (snapshots, root, write = writeFileSync) => {
  const failures = []
  for (const { relativePath, contents } of snapshots) {
    try {
      write(resolve(root, relativePath), contents)
    } catch (error) {
      failures.push(new Error(`Failed to restore ${relativePath}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      }))
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Failed to restore version files')
}

const readConsistentVersion = (definition, root) => {
  const versions = definition.versionFiles.map((path) => ({
    path,
    version: readJson(resolve(root, path)).version,
  }))
  const expected = versions[0]?.version
  const mismatches = versions.filter(({ version }) => version !== expected)
  if (typeof expected !== 'string' || mismatches.length > 0) {
    const details = versions.map(({ path, version }) => `${path}=${String(version)}`).join(', ')
    throw new Error(`Package version files are inconsistent: ${details}`)
  }
  return expected
}

const parseRegistryMetadata = (output) => {
  const value = JSON.parse(output)
  return {
    version: value.version,
    gitHead: value.gitHead,
    distTags: value['dist-tags'] ?? value.distTags ?? {},
  }
}

const isRegistryMiss = (error) => /E404|404 Not Found|No match found/i.test(error instanceof Error ? error.message : String(error))

export const createReleaseOperations = ({ root = repositoryRoot } = {}) => {
  const npmView = (args) => runPnpm(['exec', 'npm', 'view', ...args, '--json'], {
    cwd: root,
    stdio: 'pipe',
  })

  const readRegistryMetadata = (definition, version) => {
    try {
      const output = npmView([
        `${definition.packageName}@${version}`,
        'version',
        'gitHead',
        'dist-tags',
      ])
      return parseRegistryMetadata(output)
    } catch (error) {
      if (isRegistryMiss(error)) return null
      throw error
    }
  }

  return {
    root,
    cwd: () => process.cwd(),
    readCurrentVersion: (definition) => readConsistentVersion(definition, root),
    branch: () => git(root, ['branch', '--show-current'], { stdio: 'pipe' }),
    status: () => git(root, ['status', '--short'], { stdio: 'pipe' }),
    head: () => git(root, ['rev-parse', 'HEAD'], { stdio: 'pipe' }),
    installWorkspace: () => runPnpm(['install', '--frozen-lockfile'], { cwd: root }),
    testPackage: (definition) => {
      runPnpm(['--filter', '@memtensor/memos-cloud-plugin-core', 'test'], { cwd: root })
      runPnpm(['--filter', definition.packageName, 'test'], { cwd: root })
    },
    inspectPackage: (definition) => {
      const tarball = packPackage(definition.key)
      const inventory = runChecked('tar', ['-tf', tarball], { cwd: root, stdio: 'pipe' })
        .split(/\r?\n/)
        .map((line) => line.replace(/^\.\//, '').trim())
        .filter(Boolean)
      for (const required of definition.requiredPackFiles) {
        if (!inventory.includes(required)) throw new Error(`${definition.packageName} tarball is missing ${required}`)
      }
      return tarball
    },
    publishDryRun: (definition, distTag) => runPnpm([
      '--dir', definition.packageDirectory, 'publish', '--access', 'public', '--tag', distTag, '--dry-run', '--no-git-checks',
    ], { cwd: root }),
    npmWhoami: () => runPnpm(['exec', 'npm', 'whoami'], { cwd: root, stdio: 'pipe' }),
    readDistTagVersion: (definition, distTag) => {
      try {
        const version = JSON.parse(npmView([`${definition.packageName}@${distTag}`, 'version']))
        if (typeof version !== 'string') throw new Error(`npm returned an invalid ${distTag} version`)
        return version
      } catch (error) {
        if (isRegistryMiss(error)) return null
        throw error
      }
    },
    readRegistryMetadata,
    waitForRegistryMetadata: async (definition, version, { distTag, sourceCommit }) => {
      const report = await waitForNpmReleaseVisibility({
        packageName: definition.packageName,
        version,
        distTag,
        expectedGitHead: sourceCommit,
        registryUrl: process.env.NPM_CONFIG_REGISTRY,
      })
      return {
        version: report.version,
        gitHead: report.git_head,
        distTags: { [report.dist_tag]: report.dist_tag_version },
      }
    },
    confirm: async (expected) => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = await prompt.question(`Type ${expected} to continue: `)
        if (answer.trim() !== expected) throw new Error(`Publish confirmation must exactly equal: ${expected}`)
      } finally {
        prompt.close()
      }
    },
    captureVersionFiles: (definition) => captureVersionFileSnapshots(definition, root),
    updateVersionFiles: (definition, version) => {
      for (const relativePath of definition.versionFiles) {
        const path = resolve(root, relativePath)
        const value = readJson(path)
        value.version = version
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      }
    },
    restoreVersionFiles: (_definition, snapshots) => restoreVersionFileSnapshots(snapshots, root),
    commitVersion: (definition, version) => {
      git(root, ['add', '--', ...definition.versionFiles])
      git(root, ['commit', '-m', `chore(${definition.key}): release ${definition.tagPrefix}${version}`])
    },
    publish: (definition, distTag) => runPnpm([
      '--dir', definition.packageDirectory, 'publish', '--access', 'public', '--tag', distTag,
    ], { cwd: root }),
    log: (message) => process.stdout.write(`${message}\n`),
  }
}
