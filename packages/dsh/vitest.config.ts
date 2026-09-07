import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

// Point at an installed DSH runtime to run the same behavior suite against
// another supported host version, without changing the workspace lockfile.
const runtime = process.env.DSH_TEST_RUNTIME
const hostRequire = runtime ? createRequire(resolve(runtime, 'package.json')) : undefined
const hostPackages = [
  'cordis', 'cordis-plugin-include', 'cordis-plugin-loader', 'schemastery',
  'dsh-agent', 'dsh-credentials', 'dsh-launch-environment', 'dsh-llm',
  'dsh-session', 'dsh-settings',
]

export default defineConfig({
  resolve: {
    alias: hostRequire ? hostPackages.map((name) => ({
      find: `@deepseek-ai/${name}`,
      replacement: hostRequire.resolve(`@deepseek-ai/${name}`),
    })) : [],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
  },
})
