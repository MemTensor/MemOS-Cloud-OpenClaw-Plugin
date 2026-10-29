import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getPluginDefinition,
  planReleaseVersion,
  releaseConfirmation,
} from '../scripts/plugin-command-config.mjs'

test('defines independent OpenClaw and DSH package metadata', () => {
  const openclaw = getPluginDefinition('openclaw')
  const dsh = getPluginDefinition('dsh')

  assert.equal(openclaw.packageDirectory, 'packages/openclaw')
  assert.equal(openclaw.packageName, '@memtensor/memos-cloud-openclaw-plugin')
  assert.equal(openclaw.tagPrefix, 'v')
  assert.deepEqual(openclaw.versionFiles, [
    'packages/openclaw/package.json',
    'packages/openclaw/openclaw.plugin.json',
    'packages/openclaw/moltbot.plugin.json',
    'packages/openclaw/clawdbot.plugin.json',
  ])

  assert.equal(dsh.packageDirectory, 'packages/dsh')
  assert.equal(dsh.packageName, '@memtensor/memos-cloud-dsh-plugin')
  assert.equal(dsh.tagPrefix, 'dsh-v')
  assert.deepEqual(dsh.versionFiles, ['packages/dsh/package.json'])
})

test('rejects an unknown plugin key', () => {
  assert.throws(() => getPluginDefinition('unknown'), /Unknown plugin key/)
})

test('plans stable current and patch releases', () => {
  assert.deepEqual(
    planReleaseVersion({ currentVersion: '0.1.20', channel: 'stable', bump: 'current' }),
    {
      currentVersion: '0.1.20',
      targetVersion: '0.1.20',
      distTag: 'latest',
      changesVersion: false,
    },
  )
  assert.deepEqual(
    planReleaseVersion({ currentVersion: '0.1.20', channel: 'stable', bump: 'patch' }),
    {
      currentVersion: '0.1.20',
      targetVersion: '0.1.21',
      distTag: 'latest',
      changesVersion: true,
    },
  )
  assert.deepEqual(
    planReleaseVersion({ currentVersion: '0.1.0-beta.2', channel: 'stable', bump: 'patch' }),
    {
      currentVersion: '0.1.0-beta.2',
      targetVersion: '0.1.0',
      distTag: 'latest',
      changesVersion: true,
    },
  )
  assert.throws(
    () => planReleaseVersion({ currentVersion: '0.1.21-beta.0', channel: 'stable', bump: 'current' }),
    /stable current-version release requires a stable version/,
  )
})

test('plans beta current and patch releases', () => {
  assert.deepEqual(
    planReleaseVersion({ currentVersion: '0.1.21-beta.0', channel: 'beta', bump: 'current' }),
    {
      currentVersion: '0.1.21-beta.0',
      targetVersion: '0.1.21-beta.0',
      distTag: 'beta',
      changesVersion: false,
    },
  )
  assert.deepEqual(
    planReleaseVersion({ currentVersion: '0.1.20', channel: 'beta', bump: 'patch' }),
    {
      currentVersion: '0.1.20',
      targetVersion: '0.1.21-beta.0',
      distTag: 'beta',
      changesVersion: true,
    },
  )
  assert.deepEqual(
    planReleaseVersion({ currentVersion: '0.1.0-beta.2', channel: 'beta', bump: 'patch' }),
    {
      currentVersion: '0.1.0-beta.2',
      targetVersion: '0.1.0-beta.3',
      distTag: 'beta',
      changesVersion: true,
    },
  )
  assert.throws(
    () => planReleaseVersion({ currentVersion: '0.1.20', channel: 'beta', bump: 'current' }),
    /beta current-version release requires a beta prerelease/,
  )
  assert.throws(
    () => planReleaseVersion({ currentVersion: '0.1.20-beta.preview', channel: 'beta', bump: 'patch' }),
    /patch version must advance beyond 0\.1\.20-beta\.preview/,
  )
})

test('rejects invalid release inputs', () => {
  assert.throws(
    () => planReleaseVersion({ currentVersion: 'not-semver', channel: 'stable', bump: 'current' }),
    /valid SemVer/,
  )
  assert.throws(
    () => planReleaseVersion({ currentVersion: '0.1.20', channel: 'next', bump: 'current' }),
    /Unknown release channel/,
  )
  assert.throws(
    () => planReleaseVersion({ currentVersion: '0.1.20', channel: 'stable', bump: 'minor' }),
    /Unknown release bump/,
  )
})

test('builds exact package-specific confirmations', () => {
  assert.equal(releaseConfirmation(getPluginDefinition('openclaw'), '0.1.21'), 'PUBLISH v0.1.21')
  assert.equal(releaseConfirmation(getPluginDefinition('dsh'), '0.1.1'), 'PUBLISH dsh-v0.1.1')
})
