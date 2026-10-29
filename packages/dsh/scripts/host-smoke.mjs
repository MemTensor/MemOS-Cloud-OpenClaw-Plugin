// Run after packing: DSH_TEST_RUNTIME=/path/to/full/dsh-install
// DSH_TEST_PACKAGE=/path/to/plugin.tgz node scripts/host-smoke.mjs
// Uses the real CLI, loader, Settings and read tool; HTTP endpoints are local.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pnpmInvocation } from '../../../scripts/command-runtime.mjs'
import { parse } from 'yaml'

const runtime = resolve(process.env.DSH_TEST_RUNTIME)
const tarball = resolve(process.env.DSH_TEST_PACKAGE)
const version = JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version
const hostRequire = createRequire(join(runtime, 'package.json'))
const modern = 'SettingsForms' in await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-settings')))
const root = mkdtempSync(join(tmpdir(), 'memos-host-smoke-'))
const workspace = join(root, 'workspace')
mkdirSync(workspace)
writeFileSync(join(workspace, 'probe.txt'), 'TOOL-CONTENT-7391\n')
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/settings-probe.mjs')
const launcher = resolve(dirname(fileURLToPath(import.meta.url)), 'host-cli.mjs')
let current
const summaries = []
const server = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (req.url.startsWith('/memory/')) {
      assert.equal(req.headers.authorization, 'Token fixture-memory-key')
      current.requests.push({ path: req.url, body })
      res.on('close', () => { if (!res.writableEnded) current.disconnected = true })
      if (req.url === '/memory/search/memory') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ code: 0, data: { memory_detail_list: [{ memory_value: 'RECALLED-2854' }] } }))
      } else {
        // The CLI finishes its turn immediately; this reply must survive exit.
        setTimeout(() => {
          if (res.destroyed) return
          current.acknowledged = true
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ code: 0, data: { success: true } }))
        }, current.delayMs ?? 500)
      }
      return
    }
    assert.equal(req.url, '/v1/chat/completions')
    current.modelSawRecall ||= JSON.stringify(body.messages).includes('RECALLED-2854')
    const tool = body.messages.findLast(message => message.role === 'tool')
    const delta = tool ? { role: 'assistant', content: 'RECALLED-2854 TOOL-CONTENT-7391' } : {
      role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: {
        name: 'read', arguments: JSON.stringify({ file_path: 'probe.txt' }),
      } }],
    }
    const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  } catch (error) { current.serverError = String(error); res.writeHead(500); res.end('{}') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env, DSH_HOME: join(root, 'state'), DSH_TELEMETRY_DISABLED: '1', CI: '1',
  MEMOS_API_KEY: 'fixture-memory-key', FIXTURE_LLM_KEY: 'fixture-model-key',
}
delete env.MEMOS_USER_ID
const invocation = pnpmInvocation([], env.DSH_TEST_PNPM ? { ...env, npm_execpath: resolve(env.DSH_TEST_PNPM) } : env)
const pnpmVersion = spawnSync(invocation.command, [...invocation.args, '--version'], { cwd: workspace, env, encoding: 'utf8' })
if (pnpmVersion.error) throw pnpmVersion.error
assert.equal(pnpmVersion.status, 0, pnpmVersion.stderr)
const selectedPnpmVersion = pnpmVersion.stdout.trim()
if (env.DSH_TEST_PNPM_VERSION) assert.equal(selectedPnpmVersion, env.DSH_TEST_PNPM_VERSION, 'Host installation must use the requested pnpm version')
console.log(JSON.stringify({ pnpm: selectedPnpmVersion, runtime: version, evidence: root }))
// Older launchers do not accept runCli({ packageManager }); pin their PATH too.
const shimDirectory = join(root, 'bin')
mkdirSync(shimDirectory)
const proxy = join(shimDirectory, 'pnpm-proxy.cjs')
writeFileSync(proxy, `const { spawnSync } = require('node:child_process');
const invocation = JSON.parse(process.env.DSH_TEST_PNPM_INVOCATION);
const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
env[pathKey] = process.env.DSH_TEST_ORIGINAL_PATH;
const result = spawnSync(invocation.command, [...invocation.args, ...process.argv.slice(2)], {
  env, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`)
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
writeFileSync(join(shimDirectory, 'pnpm'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(proxy)} "$@"\n`)
chmodSync(join(shimDirectory, 'pnpm'), 0o755)
writeFileSync(join(shimDirectory, 'pnpm.cmd'), `@"${process.execPath}" "%~dp0pnpm-proxy.cjs" %*\r\n`)
env.DSH_TEST_PNPM_INVOCATION = JSON.stringify(invocation)
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
env.DSH_TEST_ORIGINAL_PATH = env[pathKey] ?? ''
env[pathKey] = `${shimDirectory}${delimiter}${env[pathKey] ?? ''}`

const sharedSdk = (selectedRuntime) => {
  const require = createRequire(join(selectedRuntime, 'package.json'))
  return Object.fromEntries([
    'cordis', 'dsh-agent', 'dsh-session', 'dsh-scope', 'dsh-credentials',
    'dsh-launch-environment', 'dsh-llm', 'dsh-settings',
  ].map(name => [`@deepseek-ai/${name}`, require.resolve(`@deepseek-ai/${name}`)]))
}

const packedManifest = path => JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }))
const targetManifest = packedManifest(tarball)
let previousPackage
let previousManifest
if (env.DSH_TEST_UPGRADE_FROM) {
  if (env.DSH_TEST_UPGRADE_PACKAGE) {
    previousPackage = resolve(env.DSH_TEST_UPGRADE_PACKAGE)
  } else {
    // Exercise replacement of a distinct, 0.1-only package without relying on a mutable registry tag.
    // This fixture reuses the current code; DSH_TEST_UPGRADE_PACKAGE tests a historical install's migration.
    const directory = join(root, 'previous-package')
    mkdirSync(directory)
    execFileSync('tar', ['-xzf', tarball, '-C', directory])
    const manifest = JSON.parse(readFileSync(join(directory, 'package/package.json')))
    manifest.version = '0.0.0-upgrade-fixture'
    manifest.engines.dsh = '>=0.1.0-rc.6 <0.2.0-0'
    for (const name of Object.keys(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) manifest.peerDependencies[name] = '^0.1.0-rc.6 || ^0.1.2-rc.1 || ^0.1.7-0'
    }
    writeFileSync(join(directory, 'package/package.json'), JSON.stringify(manifest))
    previousPackage = join(root, 'previous-package.tgz')
    execFileSync('tar', ['-czf', previousPackage, '-C', directory, 'package'])
  }
  previousManifest = packedManifest(previousPackage)
  assert.equal(previousManifest.name, targetManifest.name, 'The upgrade must replace the same plugin')
  assert.notEqual(previousManifest.version, targetManifest.version, 'The upgrade must change the installed plugin version')
}

async function run(args, timeout = 60_000, selectedRuntime = runtime) {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: workspace, env: { ...env, DSH_TEST_RUNTIME: selectedRuntime }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  clearTimeout(timer)
  return result
}
try {
  const appBoot = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')))
  const unsupported = { name: '@fixture/memos-incompatible', version: '1.0.0', engines: { dsh: '999.0.0' } }
  if (appBoot.evaluatePluginCompatibility?.(unsupported)?.requirements?.['engines.dsh']) {
    const directory = join(root, 'incompatible-bundle')
    const marker = join(root, 'incompatible-imported')
    mkdirSync(directory)
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      ...unsupported, type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(directory, 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export const apply = () => {};`)
    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'incompatible', name: unsupported.name }] }]))
    const rejected = await run(['plugin', '--profile', 'unsupported', 'add', directory])
    assert.notEqual(rejected.code, 0, 'An incompatible bundle must be rejected')
    assert.match(rejected.stdout + rejected.stderr, /engines\.dsh|incompatible/i)
    assert.equal(readFileSync(join(env.DSH_HOME, 'profiles/unsupported/package.json'), 'utf8').includes(unsupported.name), false)
    assert.equal(existsSync(marker), false, 'Rejected code must not be imported')
    summaries.push({ version, case: 'incompatible-host', passed: true })
    console.log(JSON.stringify(summaries.at(-1)))
  }
  const cases = [
    { label: 'normal', user: 'profile-user', delayMs: 6000 },
    ...(modern ? [
      { label: 'settings-edit', user: 'ui-user', edit: true },
      { label: 'legacy', user: 'legacy-user', legacy: 'settings.yaml' },
      { label: 'legacy-second-profile', user: 'legacy-user', sharedLegacy: true },
      { label: 'legacy-prior-profile', user: 'legacy-user', priorProfileLegacy: true },
      { label: 'imported-recovery', user: 'legacy-user', legacy: 'settings.yaml.imported' },
      { label: 'explicit-wins', user: 'profile-user', legacy: 'settings.yaml', explicit: true },
      { label: 'invalid-legacy', invalid: true, legacy: 'settings.yaml' },
    ] : []),
  ]
  if (env.DSH_TEST_UPGRADE_FROM) {
    const oldRuntime = resolve(env.DSH_TEST_UPGRADE_FROM)
    cases.push(
      { label: 'upgrade-before', profile: 'upgrade', runtime: oldRuntime, user: 'ui-user', edit: true },
      { label: 'upgrade-after', profile: 'upgrade', user: 'ui-user', reuse: true },
      { label: 'plugin-upgrade-before', profile: 'plugin-first', runtime: oldRuntime, user: 'ui-user', edit: true, previous: true },
      { label: 'plugin-upgrade-on-old-host', profile: 'plugin-first', runtime: oldRuntime, user: 'ui-user', reuse: true, update: true },
      { label: 'plugin-upgrade-after', profile: 'plugin-first', user: 'ui-user', reuse: true },
      { label: 'host-upgrade-before', profile: 'host-first', runtime: oldRuntime, user: 'ui-user', edit: true, previous: true },
      { label: 'plugin-upgrade-on-new-host', profile: 'host-first', user: 'ui-user', reuse: true, update: true },
    )
  }
  const profiles = new Map()
  for (const item of cases) {
    const profile = item.profile ?? item.label
    const selectedRuntime = item.runtime ?? runtime
    const selectedVersion = JSON.parse(readFileSync(join(selectedRuntime, 'node_modules/@deepseek-ai/dsh/package.json'))).version
    current = { requests: [], acknowledged: false, disconnected: false, modelSawRecall: false, delayMs: item.delayMs }
    if (!item.reuse) {
      const init = await run(['--profile', profile, '--from-default-profile', 'headless', '--dump-config'], 60_000, selectedRuntime)
      assert.equal(init.code, 0, init.stderr)
      const install = await run(['plugin', '--profile', profile, 'add', item.previous ? previousPackage : tarball, '--store-dir=' + join(root, 'store')], 180_000, selectedRuntime)
      assert.equal(install.code, 0, install.stderr)
      assert.match(install.stdout + install.stderr, new RegExp(`using pnpm v${selectedPnpmVersion.replaceAll('.', '\\.')}`), 'The profile must actually install with the selected pnpm')
    }
    const profileDir = join(env.DSH_HOME, 'profiles', profile)
    const manifestPath = join(profileDir, 'package.json')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const installedManifestPath = join(profileDir, 'node_modules', targetManifest.name, 'package.json')
    if (!item.reuse) {
      const manifest = JSON.parse(readFileSync(manifestPath))
      manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@memtensor/memos-cloud-dsh-plugin']
      writeFileSync(manifestPath, JSON.stringify(manifest))
      for (const path of ['settings.yaml', 'settings.yaml.imported', ...(!item.sharedLegacy ? ['memos-cloud.legacy.json'] : [])]) {
        rmSync(join(env.DSH_HOME, path), { force: true })
      }
    } else {
      const saved = profiles.get(profile)
      assert.equal(readFileSync(manifestPath, 'utf8'), saved.manifest, 'Host upgrade must preserve the installed plugin and selected bundles')
      assert.equal(readFileSync(patchPath, 'utf8'), saved.patch, 'The same profile must retain its Settings')
      if (item.update) {
        const install = await run(['plugin', '--profile', profile, 'add', tarball, '--store-dir=' + join(root, 'store')], 180_000, selectedRuntime)
        writeFileSync(join(root, `${item.label}.install.stdout`), install.stdout)
        writeFileSync(join(root, `${item.label}.install.stderr`), install.stderr)
        assert.equal(install.code, 0, install.stderr)
        assert.equal(readFileSync(patchPath, 'utf8'), saved.patch, 'Updating the plugin must preserve the profile Settings without remove/reinstall')
        const updated = JSON.parse(readFileSync(manifestPath))
        assert.deepEqual(updated.dsh.profile, JSON.parse(saved.manifest).dsh.profile, 'Updating the plugin must preserve bundle selection')
        assert.notEqual(readFileSync(installedManifestPath, 'utf8'), saved.installed, 'The update must replace the installed package')
      }
    }
    const expectedVersion = item.previous ? previousManifest.version : targetManifest.version
    assert.equal(JSON.parse(readFileSync(installedManifestPath)).version, expectedVersion, 'The expected plugin version must actually be installed')
    if (item.legacy) writeFileSync(join(env.DSH_HOME, item.legacy), item.invalid ? 'memos-cloud: invalid\n' : 'memos-cloud:\n  userId: legacy-user\n  tags: [migrated-tag]\n')
    const probe = join(root, `${item.label}.probe.json`)
    const probeModule = join(profileDir, 'memos-settings-probe.mjs')
    writeFileSync(probeModule, readFileSync(fixture))
    const sdk = sharedSdk(selectedRuntime)
    const historical = item.previous && !!env.DSH_TEST_UPGRADE_PACKAGE
    const explicitUser = (!item.legacy && !item.sharedLegacy && !item.priorProfileLegacy) || item.explicit
    const config = { baseURL: url + '/memory', apiKeyEnv: 'MEMOS_API_KEY',
      ...(explicitUser ? { userId: historical ? item.user : 'profile-user' } : {}),
      includeToolMemory: true, includePreference: false, recallGlobal: true,
      asyncMode: false, searchTimeoutMs: 5000, syncAddTimeoutMs: item.delayMs ? 10000 : 5000, searchRetries: 0, addRetries: 0,
    }
    const patch = [
      { id: 'agent-default-model', config: { provider: 'fixture', model: 'fixture-model' } },
      { id: 'llm-pi-ai', config: { providers: { fixture: {
        apiKeyEnv: 'FIXTURE_LLM_KEY', api: 'openai-completions', baseURL: url + '/v1',
        defaultContextWindow: 128000, defaultMaxTokens: 1024, timeoutMs: 5000,
        retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'fixture-model', reasoningEfforts: false }],
      } } } },
      { id: 'session-title-llm', disabled: true },
      { id: 'memos-cloud', config },
      ...(modern ? [{ insert: [{ id: 'settings-probe', name: probeModule, config: { output: probe, edit: !!item.edit, sdk } }] }] : []),
    ]
    if (item.reuse) {
      const existing = parse(readFileSync(patchPath, 'utf8'))
      assert.equal(existing.find(row => row.id === 'memos-cloud').config.userId, 'ui-user', 'Settings saved by the old host must survive its upgrade')
      const probeEntry = existing.flatMap(row => row.insert ?? []).find(row => row.id === 'settings-probe')
      probeEntry.config = { output: probe, edit: false, sdk }
      writeFileSync(patchPath, JSON.stringify(existing))
    } else writeFileSync(patchPath, JSON.stringify(patch))
    if (historical) {
      // A historical plugin need not implement today's Settings form or shutdown contract.
      // Preserve its installed package and saved profile config, then test the actual update and target behavior.
      profiles.set(profile, { manifest: readFileSync(manifestPath, 'utf8'), patch: readFileSync(patchPath, 'utf8'), installed: readFileSync(installedManifestPath, 'utf8') })
      summaries.push({ version: selectedVersion, plugin: expectedVersion, pnpm: selectedPnpmVersion, case: item.label, installed: true, startupTested: false })
      console.log(JSON.stringify(summaries.at(-1)))
      continue
    }
    const result = await run(['--profile', profile, 'Read probe.txt with the read tool and report the recalled context.', '--json'], 60_000, selectedRuntime)
    writeFileSync(join(root, `${item.label}.stdout`), result.stdout)
    writeFileSync(join(root, `${item.label}.stderr`), result.stderr)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(current.serverError, undefined)
    if (item.invalid) assert.equal(current.requests.length, 0, 'Failed migration must block memory requests')
    else {
      const searches = current.requests.filter(row => row.path.endsWith('/search/memory'))
      const adds = current.requests.filter(row => row.path.endsWith('/add/message'))
      assert.equal(searches.length, 1)
      assert.equal(adds.length, 1)
      assert.equal(searches[0].body.user_id, item.user)
      assert.equal(adds[0].body.user_id, item.user)
      assert.equal(current.modelSawRecall, true)
      assert.equal(current.acknowledged, true, 'Write must complete before host exit')
      assert.equal(current.disconnected, false, 'Host must not abort the pending write')
      assert.deepEqual(adds[0].body.messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant'])
      assert.ok(JSON.stringify(adds[0].body.messages).includes('TOOL-CONTENT-7391'))
    }
    if (modern) {
      const observed = JSON.parse(readFileSync(probe))
      assert.equal(observed.form, true, 'Settings must expose an editable form')
      assert.deepEqual(observed.errors, [], 'Cordis must not hide plugin startup errors')
      assert.deepEqual(Object.keys(observed.sdk).sort(), Object.keys(sdk).sort(), 'All shared SDK packages must be checked')
    }
    profiles.set(profile, { manifest: readFileSync(manifestPath, 'utf8'), patch: readFileSync(patchPath, 'utf8'), installed: readFileSync(installedManifestPath, 'utf8') })
    summaries.push({ version: selectedVersion, plugin: expectedVersion, pnpm: selectedPnpmVersion, case: item.label, passed: true })
    console.log(JSON.stringify(summaries.at(-1)))
  }
  console.log(JSON.stringify({ evidence: root, cases: summaries.length, passed: true }))
} catch (error) {
  console.error('Smoke evidence:', root)
  throw error
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
