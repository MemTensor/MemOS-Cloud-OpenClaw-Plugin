import assert from 'node:assert/strict'
import test from 'node:test'

import { buildReleasePlan, runRelease } from '../scripts/release-package.mjs'

const root = 'D:\\repo'
const initialHead = '1'.repeat(40)
const releaseHead = '2'.repeat(40)

const createOperations = ({ initialVersion = '0.1.20', ...overrides } = {}) => {
  const calls = []
  let registryReads = 0
  let currentHead = initialHead
  let currentVersion = initialVersion
  const operations = {
    root,
    cwd: () => root,
    readCurrentVersion: () => currentVersion,
    branch: () => 'main',
    status: () => '',
    head: () => currentHead,
    installWorkspace: () => calls.push(['installWorkspace']),
    testPackage: (definition) => calls.push(['testPackage', definition.key]),
    inspectPackage: (definition) => calls.push(['inspectPackage', definition.key]),
    publishDryRun: (definition, distTag) => calls.push(['publishDryRun', definition.key, distTag]),
    npmWhoami: () => calls.push(['npmWhoami']),
    readDistTagVersion: () => null,
    readRegistryMetadata: (_definition, version) => {
      calls.push(['readRegistryMetadata', version])
      registryReads += 1
      if (registryReads === 1) return null
      return {
        version,
        gitHead: currentHead,
        distTags: { latest: version, beta: version },
      }
    },
    confirm: (expected) => calls.push(['confirm', expected]),
    captureVersionFiles: (definition) => {
      calls.push(['captureVersionFiles', definition.key, currentVersion])
      return currentVersion
    },
    updateVersionFiles: (definition, version) => {
      calls.push(['updateVersionFiles', definition.key, version])
      currentVersion = version
    },
    restoreVersionFiles: (definition, snapshot) => {
      calls.push(['restoreVersionFiles', definition.key, snapshot])
      currentVersion = snapshot
    },
    commitVersion: (definition, version) => {
      calls.push(['commitVersion', definition.key, version])
      currentHead = releaseHead
    },
    publish: (definition, distTag) => calls.push(['publish', definition.key, distTag]),
    log: (message) => calls.push(['log', message]),
    ...overrides,
  }
  return { calls, operations, readVersion: () => currentVersion }
}

test('builds stable and beta dry-run release plans', () => {
  assert.deepEqual(
    buildReleasePlan({
      pluginKey: 'openclaw',
      channel: 'stable',
      bump: 'patch',
      dryRun: true,
      currentVersion: '0.1.20',
    }),
    {
      pluginKey: 'openclaw',
      packageName: '@memtensor/memos-cloud-openclaw-plugin',
      currentVersion: '0.1.20',
      targetVersion: '0.1.21',
      distTag: 'latest',
      changesVersion: true,
      dryRun: true,
      confirmation: 'PUBLISH v0.1.21',
    },
  )
  assert.deepEqual(
    buildReleasePlan({
      pluginKey: 'dsh',
      channel: 'beta',
      bump: 'current',
      dryRun: true,
      currentVersion: '0.1.1-beta.0',
    }),
    {
      pluginKey: 'dsh',
      packageName: '@memtensor/memos-cloud-dsh-plugin',
      currentVersion: '0.1.1-beta.0',
      targetVersion: '0.1.1-beta.0',
      distTag: 'beta',
      changesVersion: false,
      dryRun: true,
      confirmation: 'PUBLISH dsh-v0.1.1-beta.0',
    },
  )
  assert.deepEqual(
    buildReleasePlan({
      pluginKey: 'dsh',
      channel: 'beta',
      bump: 'patch',
      dryRun: true,
      currentVersion: '0.1.0-beta.2',
    }),
    {
      pluginKey: 'dsh',
      packageName: '@memtensor/memos-cloud-dsh-plugin',
      currentVersion: '0.1.0-beta.2',
      targetVersion: '0.1.0-beta.3',
      distTag: 'beta',
      changesVersion: true,
      dryRun: true,
      confirmation: 'PUBLISH dsh-v0.1.0-beta.3',
    },
  )
})

test('patch dry-run validates the target version and restores the source version', async () => {
  const { calls, operations, readVersion } = createOperations({ branch: () => 'test' })

  const result = await runRelease({
    pluginKey: 'openclaw',
    channel: 'stable',
    bump: 'patch',
    dryRun: true,
  }, operations)

  assert.equal(result.targetVersion, '0.1.21')
  assert.deepEqual(calls.filter(([name]) => name === 'publishDryRun'), [['publishDryRun', 'openclaw', 'latest']])
  assert.deepEqual(calls.filter(([name]) => name === 'captureVersionFiles'), [['captureVersionFiles', 'openclaw', '0.1.20']])
  assert.deepEqual(calls.filter(([name]) => name === 'updateVersionFiles'), [['updateVersionFiles', 'openclaw', '0.1.21']])
  assert.deepEqual(calls.filter(([name]) => name === 'restoreVersionFiles'), [['restoreVersionFiles', 'openclaw', '0.1.20']])
  assert.equal(readVersion(), '0.1.20')
  assert.equal(calls.some(([name]) => name === 'npmWhoami'), false)
  assert.equal(calls.some(([name]) => name === 'confirm'), false)
  assert.equal(calls.some(([name]) => name === 'commitVersion'), false)
  assert.equal(calls.some(([name]) => name === 'publish'), false)
})

test('beta current and patch dry-runs use beta without retaining version changes', async () => {
  const current = createOperations({ initialVersion: '0.1.0-beta.2' })
  const currentResult = await runRelease({
    pluginKey: 'dsh',
    channel: 'beta',
    bump: 'current',
    dryRun: true,
  }, current.operations)

  assert.equal(currentResult.targetVersion, '0.1.0-beta.2')
  assert.deepEqual(current.calls.filter(([name]) => name === 'publishDryRun'), [['publishDryRun', 'dsh', 'beta']])
  assert.equal(current.calls.some(([name]) => name === 'captureVersionFiles'), false)

  const patch = createOperations({ initialVersion: '0.1.0-beta.2' })
  const patchResult = await runRelease({
    pluginKey: 'dsh',
    channel: 'beta',
    bump: 'patch',
    dryRun: true,
  }, patch.operations)

  assert.equal(patchResult.targetVersion, '0.1.0-beta.3')
  assert.deepEqual(patch.calls.filter(([name]) => name === 'publishDryRun'), [['publishDryRun', 'dsh', 'beta']])
  assert.deepEqual(patch.calls.filter(([name]) => name === 'updateVersionFiles'), [['updateVersionFiles', 'dsh', '0.1.0-beta.3']])
  assert.equal(patch.readVersion(), '0.1.0-beta.2')
})

test('patch dry-run restores version files when package validation fails', async () => {
  const release = createOperations({
    initialVersion: '0.1.0-beta.2',
    publishDryRun: () => {
      throw new Error('simulated dry-run failure')
    },
  })

  await assert.rejects(
    () => runRelease({ pluginKey: 'dsh', channel: 'beta', bump: 'patch', dryRun: true }, release.operations),
    /simulated dry-run failure/,
  )
  assert.equal(release.readVersion(), '0.1.0-beta.2')
  assert.deepEqual(
    release.calls.filter(([name]) => name === 'restoreVersionFiles'),
    [['restoreVersionFiles', 'dsh', '0.1.0-beta.2']],
  )
})

test('patch dry-run preserves both publish and restoration failures', async () => {
  const release = createOperations({
    initialVersion: '0.1.0-beta.2',
    publishDryRun: () => {
      throw new Error('simulated publish failure')
    },
    restoreVersionFiles: () => {
      throw new Error('simulated restore failure')
    },
  })

  await assert.rejects(
    () => runRelease({ pluginKey: 'dsh', channel: 'beta', bump: 'patch', dryRun: true }, release.operations),
    (error) => {
      assert.equal(error instanceof AggregateError, true)
      assert.deepEqual(
        error.errors.map((failure) => failure.message),
        ['simulated publish failure', 'simulated restore failure'],
      )
      return true
    },
  )
})

test('real publishes allow any named branch', async () => {
  const { calls, operations } = createOperations({ branch: () => 'release/dsh-beta' })

  await runRelease({
    pluginKey: 'dsh',
    channel: 'beta',
    bump: 'current',
    dryRun: false,
  }, {
    ...operations,
    readCurrentVersion: () => '0.1.0-beta.2',
  })

  assert.deepEqual(calls.filter(([name]) => name === 'publish'), [['publish', 'dsh', 'beta']])
})

test('real publishes require repository root, a named branch, and a clean tree', async () => {
  const wrongRoot = createOperations({ cwd: () => 'D:\\elsewhere' }).operations
  await assert.rejects(
    () => runRelease({ pluginKey: 'openclaw', channel: 'stable', bump: 'current', dryRun: false }, wrongRoot),
    /repository root/,
  )

  const detachedHead = createOperations({ branch: () => '' }).operations
  await assert.rejects(
    () => runRelease({ pluginKey: 'openclaw', channel: 'stable', bump: 'current', dryRun: false }, detachedHead),
    /named Git branch/,
  )

  const dirty = createOperations({ status: () => ' M package.json' }).operations
  await assert.rejects(
    () => runRelease({ pluginKey: 'openclaw', channel: 'stable', bump: 'current', dryRun: false }, dirty),
    /clean Git worktree/,
  )
})

test('refuses a version that already exists before confirmation or publish', async () => {
  const { calls, operations } = createOperations({
    readRegistryMetadata: (_definition, version) => ({ version, gitHead: initialHead, distTags: { latest: version } }),
  })

  await assert.rejects(
    () => runRelease({ pluginKey: 'openclaw', channel: 'stable', bump: 'current', dryRun: false }, operations),
    /already exists on npm/,
  )
  assert.equal(calls.some(([name]) => name === 'confirm'), false)
  assert.equal(calls.some(([name]) => name === 'publish'), false)
})

test('refuses to move an npm dist-tag backward or sideways', async () => {
  const { calls, operations } = createOperations({ readDistTagVersion: () => '0.2.0' })

  await assert.rejects(
    () => runRelease({ pluginKey: 'openclaw', channel: 'stable', bump: 'patch', dryRun: false }, operations),
    /must advance npm latest beyond 0\.2\.0/,
  )
  assert.equal(calls.some(([name]) => name === 'confirm'), false)
  assert.equal(calls.some(([name]) => name === 'publish'), false)
})

test('refuses to publish when preflight changes tracked files', async () => {
  let statusReads = 0
  const { calls, operations } = createOperations({
    status: () => {
      statusReads += 1
      return statusReads === 1 ? '' : ' M packages/openclaw/package.json'
    },
  })

  await assert.rejects(
    () => runRelease({ pluginKey: 'openclaw', channel: 'stable', bump: 'current', dryRun: false }, operations),
    /preflight changed tracked files/,
  )
  assert.equal(calls.some(([name]) => name === 'confirm'), false)
  assert.equal(calls.some(([name]) => name === 'publish'), false)
})

test('publishes a committed stable current version once with exact confirmation', async () => {
  const { calls, operations } = createOperations()
  const result = await runRelease({
    pluginKey: 'openclaw',
    channel: 'stable',
    bump: 'current',
    dryRun: false,
  }, operations)

  assert.equal(result.sourceCommit, initialHead)
  assert.deepEqual(calls.filter(([name]) => name === 'confirm'), [['confirm', 'PUBLISH v0.1.20']])
  assert.deepEqual(calls.filter(([name]) => name === 'publish'), [['publish', 'openclaw', 'latest']])
  assert.equal(calls.some(([name]) => name === 'updateVersionFiles'), false)
  assert.equal(calls.some(([name]) => name === 'commitVersion'), false)
})

test('patch publishing creates one local version commit before publishing', async () => {
  const { calls, operations } = createOperations()
  const result = await runRelease({
    pluginKey: 'dsh',
    channel: 'stable',
    bump: 'patch',
    dryRun: false,
  }, operations)

  assert.equal(result.targetVersion, '0.1.21')
  assert.equal(result.sourceCommit, releaseHead)
  assert.deepEqual(calls.filter(([name]) => name === 'confirm'), [['confirm', 'PUBLISH dsh-v0.1.21']])
  assert.deepEqual(calls.filter(([name]) => name === 'updateVersionFiles'), [['updateVersionFiles', 'dsh', '0.1.21']])
  assert.deepEqual(calls.filter(([name]) => name === 'commitVersion'), [['commitVersion', 'dsh', '0.1.21']])
  assert.deepEqual(calls.filter(([name]) => name === 'publish'), [['publish', 'dsh', 'latest']])
})

test('beta current and beta-patch use the beta dist-tag', async () => {
  const current = createOperations({ readCurrentVersion: () => '0.1.21-beta.0' })
  await runRelease({ pluginKey: 'openclaw', channel: 'beta', bump: 'current', dryRun: false }, current.operations)
  assert.deepEqual(current.calls.filter(([name]) => name === 'publish'), [['publish', 'openclaw', 'beta']])

  const patch = createOperations()
  const result = await runRelease({ pluginKey: 'dsh', channel: 'beta', bump: 'patch', dryRun: false }, patch.operations)
  assert.equal(result.targetVersion, '0.1.21-beta.0')
  assert.deepEqual(patch.calls.filter(([name]) => name === 'publish'), [['publish', 'dsh', 'beta']])
})

test('rejects post-publish metadata that does not match version, commit, and dist-tag', async () => {
  const { operations } = createOperations({
    readRegistryMetadata: (() => {
      let count = 0
      return (_definition, version) => {
        count += 1
        return count === 1 ? null : { version, gitHead: 'f'.repeat(40), distTags: { latest: version } }
      }
    })(),
  })

  await assert.rejects(
    () => runRelease({ pluginKey: 'openclaw', channel: 'stable', bump: 'current', dryRun: false }, operations),
    /gitHead mismatch/,
  )
})
