import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  captureVersionFileSnapshots,
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
