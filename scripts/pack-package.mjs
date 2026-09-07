import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isMainModule, repositoryRoot, runPnpm } from './command-runtime.mjs'
import { getPluginDefinition } from './plugin-command-config.mjs'

export const tarballFileName = (packageName, version) => (
  `${packageName.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
)

export const packPackage = (pluginKey, dependencies = {}) => {
  const definition = getPluginDefinition(pluginKey)
  const root = dependencies.root ?? repositoryRoot
  const run = dependencies.runPnpm ?? runPnpm
  const packageDirectory = resolve(root, definition.packageDirectory)
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
  const artifactsDirectory = join(packageDirectory, 'artifacts')
  const tarball = join(artifactsDirectory, tarballFileName(manifest.name, manifest.version))

  mkdirSync(artifactsDirectory, { recursive: true })
  run([
    '--dir',
    definition.packageDirectory,
    'pack',
    '--pack-destination',
    artifactsDirectory,
  ], { cwd: root })

  if (!existsSync(tarball)) throw new Error(`Expected package artifact was not created: ${tarball}`)
  return tarball
}

if (isMainModule(import.meta.url)) {
  try {
    const tarball = packPackage(process.argv[2])
    process.stdout.write(`${tarball}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
