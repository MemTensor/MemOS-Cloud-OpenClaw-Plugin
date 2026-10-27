// Run after packing: DSH_TEST_RUNTIME=/path/to/full/dsh-install
// DSH_TEST_PACKAGE=/path/to/plugin.tgz node scripts/host-smoke.mjs
// Uses the real CLI, loader, Settings and read tool; HTTP endpoints are local.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtime = resolve(process.env.DSH_TEST_RUNTIME)
const tarball = resolve(process.env.DSH_TEST_PACKAGE)
const bin = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const version = JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version
const hostRequire = createRequire(join(runtime, 'package.json'))
const modern = 'SettingsForms' in await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-settings')))
const root = mkdtempSync(join(tmpdir(), 'memos-host-smoke-'))
const workspace = join(root, 'workspace')
mkdirSync(workspace)
writeFileSync(join(workspace, 'probe.txt'), 'TOOL-CONTENT-7391\n')
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/settings-probe.mjs')
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
async function run(args, timeout = 60_000) {
  const child = spawn(process.execPath, [bin, ...args], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  for (const item of [
    { label: 'normal', user: 'profile-user', delayMs: 6000 },
    ...(modern ? [
      { label: 'settings-edit', user: 'ui-user', edit: true },
      { label: 'legacy', user: 'legacy-user', legacy: 'settings.yaml' },
      { label: 'imported-recovery', user: 'legacy-user', legacy: 'settings.yaml.imported' },
      { label: 'explicit-wins', user: 'profile-user', legacy: 'settings.yaml', explicit: true },
      { label: 'invalid-legacy', invalid: true, legacy: 'settings.yaml' },
    ] : []),
  ]) {
    const profile = item.label
    current = { requests: [], acknowledged: false, disconnected: false, modelSawRecall: false, delayMs: item.delayMs }
    const init = await run(['--profile', profile, '--from-default-profile', 'headless', '--dump-config'])
    assert.equal(init.code, 0, init.stderr)
    const install = await run(['plugin', '--profile', profile, 'add', tarball, '--store-dir=' + join(root, 'store')], 180_000)
    assert.equal(install.code, 0, install.stderr)
    const profileDir = join(env.DSH_HOME, 'profiles', profile)
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath))
    manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@memtensor/memos-cloud-dsh-plugin']
    writeFileSync(manifestPath, JSON.stringify(manifest))
    for (const path of ['settings.yaml', 'settings.yaml.imported']) rmSync(join(env.DSH_HOME, path), { force: true })
    if (item.legacy) writeFileSync(join(env.DSH_HOME, item.legacy), item.invalid ? 'memos-cloud: invalid\n' : 'memos-cloud:\n  userId: legacy-user\n  tags: [migrated-tag]\n')
    const probe = join(root, `${profile}.probe.json`)
    const config = { baseURL: url + '/memory', apiKeyEnv: 'MEMOS_API_KEY',
      ...(!item.legacy || item.explicit ? { userId: 'profile-user' } : {}),
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
      ...(modern ? [{ insert: [{ id: 'settings-probe', name: fixture, config: { output: probe, edit: !!item.edit } }] }] : []),
    ]
    writeFileSync(join(profileDir, 'cordis.patch.yml'), JSON.stringify(patch))
    const result = await run(['--profile', profile, 'Read probe.txt with the read tool and report the recalled context.', '--json'])
    writeFileSync(join(root, `${profile}.stdout`), result.stdout)
    writeFileSync(join(root, `${profile}.stderr`), result.stderr)
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
    }
    summaries.push({ version, case: profile, passed: true })
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
