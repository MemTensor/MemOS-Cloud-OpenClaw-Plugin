import assert from 'node:assert/strict'
import test from 'node:test'

import { preparationPlan } from '../scripts/prepare-package.mjs'
import { tarballFileName } from '../scripts/pack-package.mjs'

test('OpenClaw preparation builds runtime files but leaves installation to the user', () => {
  const plan = preparationPlan('openclaw')

  assert.deepEqual(plan.steps, [
    { kind: 'install-workspace', pnpmArgs: ['install', '--frozen-lockfile'] },
    {
      kind: 'build',
      pnpmArgs: ['--filter', '@memtensor/memos-cloud-openclaw-plugin', 'build'],
    },
    {
      kind: 'verify-output',
      paths: ['packages/openclaw/lib/memos-core/index.js'],
    },
  ])
  assert.match(plan.manualInstallCommand, /^openclaw plugins install /)
  assert.doesNotMatch(plan.manualInstallCommand, /--link/)
  assert.match(plan.manualInstallCommand, /packages[\\/]openclaw$/)
})

test('preparation is OpenClaw-only and never executes host installation', () => {
  const serializedSteps = JSON.stringify(preparationPlan('openclaw').steps)

  assert.throws(() => preparationPlan('dsh'), /only supports OpenClaw/)
  assert.doesNotMatch(serializedSteps, /plugins? install/i)
  assert.doesNotMatch(serializedSteps, /plugin.+add/i)
  assert.doesNotMatch(serializedSteps, /restart/i)
})

test('derives pnpm-compatible scoped tarball names', () => {
  assert.equal(
    tarballFileName('@scope/plugin', '1.2.3'),
    'scope-plugin-1.2.3.tgz',
  )
  assert.equal(
    tarballFileName('@scope/plugin', '1.2.4-beta.5'),
    'scope-plugin-1.2.4-beta.5.tgz',
  )
})
