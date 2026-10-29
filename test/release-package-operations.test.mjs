import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  acceptsPublishConfirmation,
  browserApprovalNotice,
  stagedApprovalUrl,
  publishConfirmationPrompt,
  directPublishRequiresStaging,
  captureVersionFileSnapshots,
  findStagedPackage,
  parseNpmViewJson,
  parseRegistryMetadata,
  parseStageList,
  restoreVersionFileSnapshots,
} from '../scripts/release-package-operations.mjs'

const withVersionFiles = (callback) => {
  const root = mkdtempSync(join(tmpdir(), 'release-version-files-'))
  const definition = { versionFiles: ['one.json', 'nested/two.json'] }
  const originals = [
    Buffer.from('{\r\n  "version": "1.0.0"\r\n}\r\n'),
    Buffer.from('{"version":"1.0.0"}\n'),
  ]

  try {
    definition.versionFiles.forEach((relativePath, index) => {
      const path = join(root, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, originals[index])
    })
    callback({ definition, originals, root })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('stages only when direct publish is blocked by the registry policy', () => {
  assert.equal(directPublishRequiresStaging(
    '403 Forbidden - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.',
  ), true)
  assert.equal(directPublishRequiresStaging(
    'E_STAGE_REQUIRED: run npm stage publish and have the version approved',
  ), true)
  assert.equal(directPublishRequiresStaging(
    '[ERR_PNPM_OTP_NON_INTERACTIVE] The registry requires additional authentication, but pnpm is not running in an interactive terminal',
  ), true)
  assert.equal(directPublishRequiresStaging('You cannot publish over the previously published versions'), false)
  assert.equal(directPublishRequiresStaging('ENEEDAUTH This command requires you to be logged in'), false)
})

test('builds the npm staged-packages page for the publishing account', () => {
  const url = stagedApprovalUrl('leason1974')
  const notice = browserApprovalNotice({
    packageName: '@memtensor/memos-cloud-dsh-plugin',
    version: '0.1.2-beta.0',
    url,
  })
  assert.equal(url, 'https://www.npmjs.com/settings/leason1974/staged-packages')
  assert.match(notice, /请在浏览器中打开下面的链接并点击批准，插件将在批准成功后发布/)
  assert.ok(notice.split('\n').includes(url))
})

test('asks for y or n instead of the publish phrase', () => {
  assert.equal(
    publishConfirmationPrompt('PUBLISH dsh-v0.1.2-beta.0'),
    'Publish dsh-v0.1.2-beta.0? [y/n] ',
  )
})

test('accepts only y as the local publish confirmation', () => {
  assert.equal(acceptsPublishConfirmation('y'), true)
  assert.equal(acceptsPublishConfirmation('Y'), true)
  assert.equal(acceptsPublishConfirmation(' y '), true)
  assert.equal(acceptsPublishConfirmation('yes'), false)
  assert.equal(acceptsPublishConfirmation('PUBLISH dsh-v0.1.2-beta.0'), false)
})

test('selects the newest staged package for the requested version and tag', () => {
  const output = `[
    {"id":"old","packageName":"@memtensor/memos-cloud-dsh-plugin","version":"0.1.2-beta.0","tag":"beta","createdAt":"2026-10-28T01:00:00.000Z"},
    {"id":"other","packageName":"@memtensor/memos-cloud-dsh-plugin","version":"0.1.2-beta.0","tag":"latest","createdAt":"2026-10-28T03:00:00.000Z"},
    {"id":"new","packageName":"@memtensor/memos-cloud-dsh-plugin","version":"0.1.2-beta.0","tag":"beta","createdAt":"2026-10-28T02:00:00.000Z"}
  ]`
  assert.equal(
    findStagedPackage(parseStageList(output), {
      packageName: '@memtensor/memos-cloud-dsh-plugin',
      version: '0.1.2-beta.0',
      tag: 'beta',
    }).id,
    'new',
  )
  assert.equal(findStagedPackage(parseStageList('[]'), {
    packageName: '@memtensor/memos-cloud-dsh-plugin',
    version: '0.1.2-beta.0',
    tag: 'beta',
  }), null)
})

test('accepts npm 12 single-result JSON arrays', () => {
  assert.equal(parseNpmViewJson('["0.1.1-beta.0"]\n'), '0.1.1-beta.0')
  assert.equal(parseNpmViewJson('"0.1.1-beta.0"'), '0.1.1-beta.0')
  assert.deepEqual(
    parseRegistryMetadata(`[
      {
        "version": "0.1.1",
        "gitHead": "abc",
        "dist-tags": { "beta": "0.1.1-beta.0" }
      }
    ]`),
    {
      version: '0.1.1',
      gitHead: 'abc',
      distTags: { beta: '0.1.1-beta.0' },
    },
  )
  assert.throws(() => parseNpmViewJson('["0.1.1","0.1.2"]'), /2 JSON results/)
})

test('captures and restores version files byte-for-byte', () => {
  withVersionFiles(({ definition, originals, root }) => {
    const snapshots = captureVersionFileSnapshots(definition, root)
    assert.equal(snapshots.every(({ contents }) => Buffer.isBuffer(contents)), true)

    for (const relativePath of definition.versionFiles) {
      writeFileSync(join(root, relativePath), '{"version":"changed"}\n')
    }
    restoreVersionFileSnapshots(snapshots, root)

    definition.versionFiles.forEach((relativePath, index) => {
      assert.deepEqual(readFileSync(join(root, relativePath)), originals[index])
    })
  })
})

test('attempts every version-file restore and aggregates write failures', () => {
  withVersionFiles(({ definition, originals, root }) => {
    const snapshots = captureVersionFileSnapshots(definition, root)
    for (const relativePath of definition.versionFiles) {
      writeFileSync(join(root, relativePath), 'changed')
    }

    const attempted = []
    assert.throws(
      () => restoreVersionFileSnapshots(snapshots, root, (path, contents) => {
        attempted.push(path)
        if (path.endsWith('one.json')) throw new Error('simulated locked file')
        writeFileSync(path, contents)
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true)
        assert.equal(error.errors.length, 1)
        assert.match(error.errors[0].message, /simulated locked file/)
        return true
      },
    )

    assert.equal(attempted.length, 2)
    assert.deepEqual(readFileSync(join(root, 'nested/two.json')), originals[1])
  })
})
