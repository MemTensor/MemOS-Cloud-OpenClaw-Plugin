import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import semver from 'semver'

const manifest = JSON.parse(readFileSync(new URL('../packages/dsh/package.json', import.meta.url)))
const certified = ['0.1.0-rc.6', '0.1.2-rc.1', '0.1.7-rc.2', '0.2.1-rc.2', '0.2.1-rc.4']

test('certified DSH releases satisfy both the host gate and standard SDK peer resolution', () => {
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(peers.length > 0)
  for (const version of certified) {
    assert.ok(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), `DSH must accept ${version}`)
    for (const [name, range] of peers) {
      assert.ok(semver.satisfies(version, range), `The package manager must accept ${name}@${version}`)
    }
  }
})

test('both supported host series accept later releases without adding an exact-version exemption', () => {
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  for (const version of ['0.1.0', '0.1.8', '0.1.99', '0.2.0', '0.2.1', '0.2.2', '0.2.99']) {
    assert.ok(semver.satisfies(version, manifest.engines.dsh), version)
    for (const [name, range] of peers) assert.ok(semver.satisfies(version, range), `${name}@${version}`)
  }
  // DSH's gate (including its legacy peer fallback) opts into prerelease matching.
  for (const version of ['0.1.7-rc.1', '0.1.8-rc.1', '0.2.0-alpha.1', '0.2.1-rc.3', '0.2.2-alpha.2']) {
    assert.ok(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), version)
    for (const [name, range] of peers) assert.ok(semver.satisfies(version, range, { includePrerelease: true }), `${name}@${version}`)
  }
})

test('the supported series exclude older SDKs and the next breaking host series', () => {
  for (const version of ['0.0.9', '0.1.0-rc.5', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), false, version)
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, `${name}@${version}`)
    }
  }
})

test('artifact verification requires a real DSH host before packing, including without npm_execpath', () => {
  const env = { ...process.env }
  delete env.npm_execpath
  delete env.DSH_TEST_RUNTIME
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/verify-package-artifacts.mjs', import.meta.url)), '--plugin', 'dsh',
  ], { env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Set DSH_TEST_RUNTIME to a full supported DSH installation/)
})
