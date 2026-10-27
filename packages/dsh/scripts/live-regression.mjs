// Explicit opt-in integration test; uses actual DSH, LLM and MemOS endpoints.
// node scripts/live-regression.mjs /absolute/non-secret-config.json [before|all|defaults]
// Config supplies runtimes.old/target, plugin tarball, envFiles, modelURL/model,
// modelKeyEnv, memoryURL, and an evidence root. Credentials are never persisted.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const config = JSON.parse(readFileSync(resolve(process.argv[2])))
const phase = process.argv[3] ?? 'all'
const runId = `real-${phase}-${Date.now()}`
const root = join(config.root, runId)
const home = join(root, 'state')
const workspace = join(root, 'workspace')
mkdirSync(workspace, { recursive: true })
mkdirSync(join(root, 'logs'))
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const observer = join(sourceRoot, 'tests/fixtures/live-fetch-observer.mjs')
const probe = join(sourceRoot, 'tests/fixtures/live-host-probe.mjs')
const loaded = Object.assign({}, ...config.envFiles.map(path => parseEnv(readFileSync(path, 'utf8'))))
const secrets = { MEMOS_API_KEY: loaded.MEMOS_API_KEY, [config.modelKeyEnv]: loaded[config.modelKeyEnv] }
assert.ok(Object.values(secrets).every(Boolean), 'Missing test credentials')
const redact = value => Object.values(secrets).reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value))
const save = (path, value) => writeFileSync(join(root, path), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'))
const readLines = path => !existsSync(path) ? [] : readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const report = { runId, phase, started: new Date().toISOString(), model: { endpoint: config.modelURL, model: config.model },
  memory: config.memoryURL, package: config.plugin, packageSHA256: createHash('sha256').update(readFileSync(config.plugin)).digest('hex'),
  cases: [], installations: [], seeds: [], failures: [], root,
}
const persist = () => { save('results.json', report); writeFileSync(join(config.root, `latest-${phase}.json`), JSON.stringify({ root, results: join(root, 'results.json') })) }
const progress = event => console.log(JSON.stringify({ time: new Date().toISOString(), ...event }))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const versions = Object.fromEntries(Object.entries(config.runtimes).map(([key, path]) => [key, JSON.parse(readFileSync(join(path, 'node_modules/@deepseek-ai/dsh/package.json'))).version]))
report.versions = versions
persist()

async function cli(runtime, label, args, expectedWord) {
  const started = Date.now()
  const env = { ...process.env, ...secrets, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', CI: '1',
    DSH_LIVE_FETCH_LOG: join(root, 'logs', label + '.fetch.jsonl'), DSH_LIVE_MODEL_KEY_ENV: config.modelKeyEnv,
    DSH_LIVE_HOST_LOG: join(root, 'logs', label + '.host.jsonl'),
  }
  delete env.MEMOS_USER_ID
  const child = spawn(process.execPath, ['--import', observer, join(config.runtimes[runtime], 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ...args], {
    cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => { stderr += value })
  let runnerTimedOut = false
  const timer = setTimeout(() => { runnerTimedOut = true; child.kill('SIGTERM') }, expectedWord === undefined ? 240000 : 480000)
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  clearTimeout(timer)
  save(`logs/${label}.stdout`, stdout)
  save(`logs/${label}.stderr`, stderr)
  const events = stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const trace = readLines(env.DSH_LIVE_FETCH_LOG)
  const host = readLines(join(root, 'logs', label + '.host.jsonl'))
  const adds = trace.filter(row => row.event === 'request' && row.url.endsWith('/add/message'))
  const searches = trace.filter(row => row.event === 'request' && row.url.endsWith('/search/memory'))
  const confirmations = adds.map(row => ({
    id: row.id, requestTime: row.time,
    response: trace.find(value => value.id === row.id && value.event === 'response-body'),
    failure: trace.find(value => value.id === row.id && ['fetch-error', 'body-error'].includes(value.event)),
    abort: trace.find(value => value.id === row.id && value.event === 'signal-abort'),
  }))
  const text = events.findLast(row => row.type === 'final')?.text ?? ''
  const summary = { label, version: versions[runtime], exitCode: result.code, signal: result.signal, runnerTimedOut,
    elapsedMs: Date.now() - started, sessionId: events.find(row => row.type === 'session')?.sessionId, finalText: text,
    expectedAnswer: expectedWord === undefined ? undefined : text.includes(expectedWord),
    searchUsers: searches.map(row => row.body.user_id), addUsers: adds.map(row => row.body.user_id),
    searchTimings: searches.map(row => ({
      responseMs: trace.find(value => value.id === row.id && value.event === 'response-body')?.elapsedMs,
      abortMs: trace.find(value => value.id === row.id && value.event === 'signal-abort')?.elapsedMs,
    })),
    addModes: adds.map(row => row.body.async_mode), confirmations,
    toolResults: events.filter(row => row.type === 'tool_result').map(row => ({ callId: row.callId, status: row.status })),
    toolPairs: adds.flatMap(row => {
      const calls = row.body.messages.flatMap(message => message.tool_calls ?? [])
      return row.body.messages.filter(message => message.role === 'tool').map(message => ({
        callId: message.tool_call_id, linked: calls.some(call => call.id === message.tool_call_id),
      }))
    }),
    settings: host.filter(row => ['settings', 'settings-edit'].includes(row.event)),
    logs: host.flatMap(row => row.event === 'logs' ? row.records : row.event === 'log' ? [row.record] : []),
    completed: events.some(row => row.type === 'status' && row.phase === 'turn_end' && row.reason?.kind === 'completed'),
    processExitTime: trace.findLast(row => row.event === 'process-exit')?.time,
  }
  if (expectedWord !== undefined) {
    report.cases.push(summary)
    persist()
    progress({ case: label, version: summary.version, exitCode: summary.exitCode, correct: summary.expectedAnswer,
      completed: summary.completed, adds: confirmations.map(row => ({ ms: row.response?.elapsedMs ?? row.failure?.elapsedMs, code: row.response?.body?.code, error: row.failure?.name })),
    })
  }
  return summary
}

async function install(runtime, profile, tarball = config.plugin) {
  const init = await cli(runtime, `${profile}-${runtime}-init`, ['--profile', profile, '--from-default-profile', 'headless', '--dump-config'])
  assert.equal(init.exitCode, 0, 'Profile initialization failed')
  const result = await cli(runtime, `${profile}-${runtime}-install`, ['plugin', '--profile', profile, 'add', tarball, '--store-dir=' + join(root, 'store')])
  report.installations.push({ runtime: versions[runtime], profile, tarball, exitCode: result.exitCode })
  persist()
  assert.equal(result.exitCode, 0, 'Plugin install failed')
  const manifestPath = join(home, 'profiles', profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath))
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@memtensor/memos-cloud-dsh-plugin']
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

function patch(profile, label, user, options = {}) {
  const memos = { apiKeyEnv: 'MEMOS_API_KEY', baseURL: config.memoryURL, ...(options.omitUser ? {} : { userId: user }),
    recallEnabled: true, addEnabled: options.add ?? false, includeToolMemory: true, includePreference: false,
    recallGlobal: true, relativity: 0, asyncMode: options.asyncMode ?? true,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.searchTimeoutMs === undefined ? {} : { searchTimeoutMs: options.searchTimeoutMs }),
    ...(options.syncAddTimeoutMs === undefined ? {} : { syncAddTimeoutMs: options.syncAddTimeoutMs }),
    searchRetries: 0, addRetries: 0, tags: ['dsh-real-upgrade-regression'],
  }
  const entries = [
    { id: 'agent-default-model', config: { provider: 'real-upgrade', model: config.model } },
    { id: 'llm-pi-ai', config: { providers: { 'real-upgrade': {
      apiKeyEnv: config.modelKeyEnv, api: 'openai-completions', baseURL: config.modelURL,
      defaultContextWindow: 128000, defaultMaxTokens: 1024, timeoutMs: 120000,
      retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: config.model, reasoningEfforts: false }],
    } } } },
    { id: 'session-title-llm', disabled: true }, { id: 'memos-cloud', config: memos },
    { insert: [{ id: 'real-live-probe', name: probe, config: { output: join(root, 'logs', label + '.host.jsonl'), ...(options.edit ? { edit: options.edit } : {}) } }] },
  ]
  writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), JSON.stringify(entries, null, 2) + '\n')
}

async function cloud(label, path, body, timeout = 90000) {
  const started = Date.now()
  let result
  try {
    const response = await fetch(config.memoryURL + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Token ' + secrets.MEMOS_API_KEY },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    })
    const data = await response.json()
    result = { status: response.status, elapsedMs: Date.now() - started, body: data }
  } catch (error) { result = { elapsedMs: Date.now() - started, error: { name: error.name, message: error.message } } }
  appendFileSync(join(root, 'logs', label + '.cloud.jsonl'), redact(JSON.stringify({ path, request: body, ...result })) + '\n')
  return result
}

async function searchable(label, user, query, word) {
  const started = Date.now()
  for (let attempt = 1; attempt <= 15; attempt++) {
    const response = await cloud(label, '/search/memory', { user_id: user, query, memory_limit_number: 25,
      include_preference: false, include_tool_memory: true, tool_memory_limit_number: 15, relativity: 0,
    }, 30000)
    if (JSON.stringify(response.body?.data).includes(word)) return { found: true, attempt, elapsedMs: Date.now() - started }
    if (attempt < 15) await pause(3000)
  }
  return { found: false, elapsedMs: Date.now() - started }
}

async function seed(user, label) {
  const word = '青杉-' + Math.random().toString(36).slice(2, 10)
  const marker = `UPGRADE-${label}-${Date.now()}`
  const response = await cloud(label + '-seed', '/add/message', { user_id: user, conversation_id: marker,
    source: 'DSH', async_mode: true, allow_public: false, tags: ['dsh-real-upgrade-regression'],
    messages: [{ role: 'user', content: `请记住测试事实：测试编号 ${marker} 的校验词是 ${word}。` }],
  })
  assert.equal(response.status, 200)
  assert.ok([0, '0', 200, '200'].includes(response.body.code))
  const found = await searchable(label + '-seed-search', user, marker + ' 的校验词', word)
  assert.equal(found.found, true, 'Seed must be searchable before testing DSH')
  const value = { user, label, word, marker, responseMs: response.elapsedMs, ...found }
  report.seeds.push(value); persist()
  return value
}

const recallPrompt = memory => `请只依据已召回的 MemOS 记忆回答：测试编号 ${memory.marker} 的校验词是什么？只回复校验词。本轮禁止调用任何工具；若记忆中没有答案，回复 UNKNOWN。`
async function recall(runtime, profile, label, memory, options = {}) {
  patch(profile, label, memory.user, options)
  return cli(runtime, label, ['--profile', profile, recallPrompt(memory), '--json', ...(options.sessionId ? ['--session-id', options.sessionId] : [])], memory.word)
}
async function toolTurn(runtime, profile, label, user, options) {
  const word = `TOOL-${label}-${Math.random().toString(36).slice(2, 10)}`
  const marker = `TOOL-CASE-${label}-${Date.now()}`
  const filename = label + '.txt'
  writeFileSync(join(workspace, filename), `测试编号 ${marker} 的工具回写校验词是 ${word}。\n`)
  patch(profile, label, user, { ...options, add: true })
  const result = await cli(runtime, label, ['--profile', profile,
    `请必须实际调用 read 工具读取当前目录的 ${filename}，然后只回复文件里的工具回写校验词，不要猜测。测试编号 ${marker}。`, '--json'], word)
  result.memory = { user, word, marker }
  result.cloudSearch = await searchable(label + '-verify', user, marker + ' 工具回写校验词', word)
  result.writeConfirmedBeforeExit = result.confirmations.length > 0 && result.confirmations.every(row => (
    [0, '0', 200, '200'].includes(row.response?.body?.code) && row.response.time < result.processExitTime
  ))
  result.passed = result.exitCode === 0 && result.expectedAnswer && result.completed && result.toolPairs.length > 0
    && result.toolPairs.every(row => row.linked) && result.cloudSearch.found && result.writeConfirmedBeforeExit
    && result.logs.every(row => row.type !== 'error')
  persist()
  return result
}

async function check(name, run) {
  try { await run() } catch (error) {
    report.failures.push({ case: name, error: redact(error.stack ?? error) }); persist()
    progress({ failed: name, error: redact(error.message) })
  }
}

try {
  progress({ runId, root, versions, model: config.model, realEndpoints: true })
  if (phase === 'before') {
    const user = runId + '-sync'
    await install('target', 'sync-before')
    const result = await toolTurn('target', 'sync-before', 'sync-before-60s', user, { asyncMode: false, timeoutMs: 60000 })
    progress({ case: result.label, passed: result.passed, confirmedBeforeExit: result.writeConfirmedBeforeExit, cloudSearch: result.cloudSearch })
  } else if (phase === 'defaults') {
    for (const runtime of ['old', 'target']) await check(runtime + '-default-async', async () => {
      const profile = runtime + '-default-async'
      const user = runId + '-' + runtime
      await install(runtime, profile)
      const result = await toolTurn(runtime, profile, profile, user, { asyncMode: true })
      assert.equal(result.passed, true, 'Default timeout must permit async write confirmation and search')
      patch(profile, profile + '-recall', user, { add: false, asyncMode: true })
      const recalled = await cli(runtime, profile + '-recall', ['--profile', profile,
        `请只依据 MemOS 记忆，回答测试编号 ${result.memory.marker} 的工具回写校验词。仅回复该词，禁止调用工具。`, '--json'], result.memory.word)
      assert.equal(recalled.expectedAnswer, true)
    })
  } else {
    const user = runId + '-shared'
    const memory = await seed(user, 'shared')
    const profile = 'upgrade'
    await install('old', profile)
    let oldSession
    await check('old-recall', async () => {
      const result = await recall('old', profile, 'old-recall', memory)
      oldSession = result.sessionId
      assert.equal(result.expectedAnswer, true)
      assert.equal(result.searchUsers[0], user)
      assert.equal(result.settings[0]?.formPresent, true)
    })
    for (const [runtime, label] of [['old', 'old'], ['target', 'target']]) {
      if (runtime === 'target') {
        // Reuse the same profile, persisted settings and sessions across hosts.
        await check('upgrade-recall', async () => {
          const result = await cli(runtime, 'upgrade-recall', ['--profile', profile, recallPrompt(memory), '--json',
            ...(oldSession ? ['--session-id', oldSession] : []),
          ], memory.word)
          assert.equal(result.expectedAnswer, true)
          if (oldSession) assert.equal(result.sessionId, oldSession)
          assert.equal(result.searchUsers[0], user)
        })
      }
      for (const asyncMode of [true, false]) await check(`${label}-${asyncMode ? 'async' : 'sync'}`, async () => {
        const syncAddTimeoutMs = config.syncTimeoutMs ?? 180000
        const result = await toolTurn(runtime, profile, `${label}-${asyncMode ? 'async-5s' : 'sync-' + syncAddTimeoutMs / 1000 + 's'}`, user, {
          asyncMode, searchTimeoutMs: 5000, syncAddTimeoutMs,
        })
        assert.equal(result.passed, true, 'Tool write must be confirmed before exit and searchable')
        assert.ok(result.addModes.every(value => value === asyncMode))
        patch(profile, label + '-cross-session', user, { add: false })
        const recalled = await cli(runtime, label + '-' + asyncMode + '-cross-session', ['--profile', profile,
          `请依据 MemOS 已召回的记忆，回答测试编号 ${result.memory.marker} 的工具回写校验词。仅回复该词，禁止调用任何工具。`, '--json'], result.memory.word)
        assert.equal(recalled.expectedAnswer, true)
      })
      await check(label + '-legacy-timeout', async () => {
        const result = await toolTurn(runtime, profile, label + '-legacy-timeout', user, { asyncMode: false, timeoutMs: 180000 })
        assert.equal(result.passed, true, 'An unchanged legacy timeout must still permit synchronous cloud processing')
        assert.ok(result.addModes.every(value => value === false))
      })
      await check(label + '-settings-async-switch', async () => {
        const result = await toolTurn(runtime, profile, label + '-settings-async-switch', user, {
          asyncMode: false, timeoutMs: 60000, searchTimeoutMs: 5000, syncAddTimeoutMs: 180000,
          edit: { asyncMode: true },
        })
        assert.equal(result.passed, true)
        assert.ok(result.addModes.every(value => value === true), 'Settings must switch the write mode immediately')
        assert.equal(result.settings.find(row => row.event === 'settings')?.syncAddTimeoutMs, 180000)
        const restart = await cli(runtime, label + '-settings-async-restart', ['--profile', profile,
          `请依据 MemOS 已召回的记忆，回答测试编号 ${result.memory.marker} 的工具回写校验词。仅回复该词，禁止调用任何工具。`, '--json'], result.memory.word)
        assert.equal(restart.expectedAnswer, true)
        assert.ok(restart.addModes.length > 0 && restart.addModes.every(value => value === true))
        assert.ok(restart.confirmations.every(row => [0, '0', 200, '200'].includes(row.response?.body?.code)))
      })
    }
    await check('settings-edit', async () => {
      const edited = await seed(runId + '-edited', 'settings')
      patch(profile, 'settings-edit', memory.user, { edit: { userId: edited.user, tags: ['dsh-settings-regression'] } })
      const result = await cli('target', 'settings-edit', ['--profile', profile, recallPrompt(edited), '--json'], edited.word)
      assert.equal(result.expectedAnswer, true)
      assert.equal(result.searchUsers[0], edited.user)
      assert.equal(result.settings.find(row => row.event === 'settings-edit')?.success, true)
      // Read the edited user's own fact in a new process without rewriting config.
      const restart = await cli('target', 'settings-restart', ['--profile', profile, recallPrompt(edited), '--json'], edited.word)
      assert.equal(restart.expectedAnswer, true)
      assert.equal(restart.searchUsers[0], edited.user)
    })
    for (const imported of [false, true]) await check(imported ? 'imported-recovery' : 'legacy-migration', async () => {
      const name = imported ? 'imported-recovery' : 'legacy-migration'
      const legacy = await seed(runId + '-' + name, name)
      await install('target', name)
      writeFileSync(join(home, imported ? 'settings.yaml.imported' : 'settings.yaml'), `memos-cloud:\n  userId: ${legacy.user}\n  tags: [dsh-migrated]\n  timeoutMs: 60000\n`)
      const result = await recall('target', name, name, legacy, { omitUser: true })
      assert.equal(result.expectedAnswer, true)
      assert.equal(result.searchUsers[0], legacy.user)
      assert.equal(result.settings.find(row => row.event === 'settings')?.timeoutMs, 60000)
      assert.ok(existsSync(join(home, 'profiles', name, 'memos-cloud.migration.json')))
      const restart = await cli('target', name + '-restart', ['--profile', name, recallPrompt(legacy), '--json'], legacy.word)
      assert.equal(restart.expectedAnswer, true)
      assert.equal(restart.searchUsers[0], legacy.user)
    })
    await check('explicit-wins', async () => {
      await install('target', 'explicit-wins')
      writeFileSync(join(home, 'settings.yaml'), `memos-cloud:\n  userId: ${runId}-unused-legacy\n`)
      const result = await recall('target', 'explicit-wins', 'explicit-wins', memory)
      assert.equal(result.expectedAnswer, true)
      assert.equal(result.searchUsers[0], memory.user)
    })
    // Repeat the previous short-budget scenario directly, without a proxy.
    if (!config.skipShortTimeoutObservation) await check('sync-14s-observation', async () => {
      const result = await toolTurn('target', profile, 'target-sync-14s', user, { asyncMode: false, syncAddTimeoutMs: 14000 })
      result.observationOnly = true
      persist()
    })
    await check('invalid-legacy', async () => {
      await install('target', 'invalid-legacy')
      writeFileSync(join(home, 'settings.yaml'), 'memos-cloud: invalid\n')
      patch('invalid-legacy', 'invalid-legacy', runId + '-unused', { omitUser: true, add: true })
      const result = await cli('target', 'invalid-legacy', ['--profile', 'invalid-legacy',
        '请只依据已召回的 MemOS 记忆回答：未提供的校验词是什么？没有记忆就只回复 UNKNOWN。本轮禁止调用任何工具。', '--json'], 'UNKNOWN')
      assert.equal(result.exitCode, 0)
      assert.equal(result.searchUsers.length, 0)
      assert.equal(result.addUsers.length, 0)
      rmSync(join(home, 'settings.yaml'), { force: true })
      rmSync(join(home, 'settings.yaml.imported'), { force: true })
    })
  }
} catch (error) {
  report.failures.push({ case: 'setup', error: redact(error.stack ?? error) })
} finally {
  report.finished = new Date().toISOString()
  report.passed = report.failures.length === 0 && report.cases.filter(row => !row.observationOnly && row.passed !== undefined).every(row => row.passed)
  persist()
  progress({ root, cases: report.cases.length, failures: report.failures, passed: report.passed })
  if (!report.passed) process.exitCode = 1
}
