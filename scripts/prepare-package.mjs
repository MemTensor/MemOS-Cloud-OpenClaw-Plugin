import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { isMainModule, repositoryRoot, runPnpm } from './command-runtime.mjs'
import { getPluginDefinition } from './plugin-command-config.mjs'

const rootRelativeCommandPath = (path) => `.\\${path.replaceAll('/', '\\')}`

export const preparationPlan = (pluginKey) => {
  if (pluginKey !== 'openclaw') {
    throw new Error('Preparation only supports OpenClaw; use pnpm pack:dsh for DSH')
  }

  const definition = getPluginDefinition(pluginKey)
  return {
    steps: [
      { kind: 'install-workspace', pnpmArgs: ['install', '--frozen-lockfile'] },
      { kind: 'build', pnpmArgs: ['--filter', definition.packageName, 'build'] },
      { kind: 'verify-output', paths: [...definition.requiredBuildOutputs] },
    ],
    manualInstallCommand: `openclaw plugins install ${rootRelativeCommandPath(definition.packageDirectory)}`,
  }
}

export const preparePackage = (pluginKey, dependencies = {}) => {
  const root = dependencies.root ?? repositoryRoot
  const run = dependencies.runPnpm ?? runPnpm
  const plan = preparationPlan(pluginKey)

  for (const step of plan.steps) {
    if (step.pnpmArgs !== undefined) run(step.pnpmArgs, { cwd: root })
    if (step.kind === 'verify-output') {
      for (const path of step.paths) {
        if (!existsSync(resolve(root, path))) throw new Error(`Expected build output is missing: ${path}`)
      }
    }
  }

  process.stdout.write(`Preparation complete. Install manually when ready:\n${plan.manualInstallCommand}\n`)
  return { manualInstallCommand: plan.manualInstallCommand }
}

if (isMainModule(import.meta.url)) {
  try {
    preparePackage(process.argv[2])
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
