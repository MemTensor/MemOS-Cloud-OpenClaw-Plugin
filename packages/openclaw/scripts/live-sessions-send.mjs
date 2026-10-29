// Explicit live integration: real OpenClaw Gateway, sessions_send, LLM and MemOS.
// node live-sessions-send.mjs /absolute/non-secret-config.json --live
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

assert.equal(process.argv[3], '--live', 'Pass --live to authorize real model/MemOS requests and synthetic memory writes.');
const settings = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const selectedVariants = settings.variants ?? ['baseline', 'candidate'];
assert.ok(selectedVariants.length && new Set(selectedVariants).size === selectedVariants.length && selectedVariants.every(name => ['baseline', 'candidate'].includes(name)), 'variants must select baseline and/or candidate.');
assert.ok(selectedVariants.includes('baseline'), 'A baseline is required for comparison.');
assert.ok(settings.expectedBaselineMemory === undefined || ['present', 'absent'].includes(settings.expectedBaselineMemory));
const candidatePlacement = settings.expectedCandidatePlacement ?? 'system';
assert.ok(['system', 'prepend'].includes(candidatePlacement), 'expectedCandidatePlacement must be system or prepend.');
const fixtures = settings.fixtures ?? resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures');
const operatorConfig = JSON.parse(readFileSync(settings.sourceConfig, 'utf8'));
const loadedEnv = Object.assign({}, ...settings.envFiles.map(path => parseEnv(readFileSync(path, 'utf8'))));
const inherited = { ...process.env, ...loadedEnv };
const provider = structuredClone(operatorConfig.models.providers[settings.modelProvider]);
assert.equal(provider.api, 'openai-completions', 'This live runner observes an OpenAI Chat Completions-compatible provider.');
const resolveValue = value => typeof value === 'string' ? value.replace(/\$\{([^}]+)\}/g, (_, key) => inherited[key] ?? '') : value;
const modelKey = resolveValue(provider.apiKey);
const memosKey = inherited.MEMOS_API_KEY;
assert.ok(modelKey && memosKey, 'Model and MemOS test credentials are required.');
const model = settings.model ?? provider.models[0].id;
const memoryURL = settings.memoryURL ?? loadedEnv.MEMOS_BASE_URL ?? 'https://memos.memtensor.cn/api/openmem/v1';
const runId = 'pr177-live-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
const root = join(settings.outputRoot, runId);
mkdirSync(root, { recursive: true, mode: 0o700 });
const secrets = [modelKey, memosKey];
const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
const save = (path, value) => writeFileSync(join(root, path), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'), { mode: 0o600 });
const lines = path => !existsSync(path) ? [] : readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const progress = data => console.log(redact(JSON.stringify({ time: new Date().toISOString(), ...data })));
const report = { runId, root, started: new Date().toISOString(), versions: { openclaw: JSON.parse(readFileSync(join(dirname(settings.openclawCli), 'package.json'))).version },
  refs: settings.refs, selectedVariants, expectedBaselineMemory: settings.expectedBaselineMemory, expectedCandidatePlacement: candidatePlacement, model: { id: model, endpoint: provider.baseUrl, runtime: 'openclaw' }, memoryURL, seeds: [], cases: [], failures: [] };
report.pluginHashes = Object.fromEntries(selectedVariants.map(name => [name, name === 'baseline' ? settings.basePlugin : settings.candidatePlugin]).map(([name, path]) => [name,
  Object.fromEntries(['index.js', 'lib/memos-cloud-api.js', 'openclaw.plugin.json', ...(existsSync(join(path, 'lib/recall-host-version.js')) ? ['lib/recall-host-version.js'] : [])].map(file => [file, createHash('sha256').update(readFileSync(join(path, file))).digest('hex')]))]));
const persist = () => save('results.json', report);
const userId = runId;
const marker = 'PR177-CHECK-' + randomBytes(5).toString('hex');
const answer = 'CERULEAN-' + String(100000 + randomBytes(3).readUIntBE(0, 3) % 900000);
const question = `PR177_RECEIVER_QUERY: What is the verification code for test ${marker}? Use only the retrieved MemOS memories. Reply with the code alone. If the code is absent, reply UNKNOWN. Do not call tools or guess.`;
const caseTag = label => 'PR177_DELIVERY_CASE: ' + label;
const caseQuestion = label => question.replace('PR177_RECEIVER_QUERY:', 'PR177_RECEIVER_QUERY (' + caseTag(label) + '):');
persist();
progress({ root, openclaw: report.versions.openclaw, model, realMemOS: true });

async function cloud(path, body) {
  const start = Date.now();
  const response = await fetch(memoryURL.replace(/\/$/, '') + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Token ' + memosKey },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const result = await response.json();
  appendFileSync(join(root, 'cloud.jsonl'), redact(JSON.stringify({ time: Date.now(), path, request: body, status: response.status, elapsedMs: Date.now() - start, body: result })) + '\n', { mode: 0o600 });
  assert.equal(response.status, 200, `MemOS ${path} HTTP status`);
  assert.ok([0, '0', 200, '200'].includes(result.code), `MemOS ${path} application status`);
  return result;
}
async function seed() {
  await cloud('/add/message', { user_id: userId, conversation_id: runId + '-seed', agent_id: 'receiver',
    source: 'openclaw', async_mode: true, allow_public: false, tags: ['openclaw-live-sessions-send-regression', runId],
    messages: [{ role: 'user', content: `Remember this synthetic test fact: the verification code for test ${marker} is ${answer}.` }] });
  for (let attempt = 1; attempt <= 20; attempt++) {
    const result = await cloud('/search/memory', { user_id: userId, query: question, memory_limit_number: 25,
      include_preference: false, include_tool_memory: false, relativity: 0, filter: { user: { and: [{ agent_id: 'receiver' }] } } });
    // Fast-path UserMemory may be replaced by the asynchronous extracted memory.
    // Wait for the exact code in the settled long-term result before testing a host.
    if (result.data?.memory_detail_list?.some(item => item.memory_type === 'LongTermMemory' && JSON.stringify(item).includes(answer))) {
      report.seeds.push({ userId, marker, answer, searchable: true, settledLongTerm: true, attempts: attempt }); persist();
      progress({ seedSearchable: true, attempts: attempt }); return;
    }
    await pause(3000);
  }
  throw new Error('The real MemOS seed did not become searchable; do not interpret this as a host recall failure.');
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
// Observe the final HTTP payload even when the SDK uses its own fetch client.
// Forward the original body bytes and stream the real provider response unchanged.
async function modelRelay(variantRoot) {
  const endpoint = new URL(provider.baseUrl.endsWith('/') ? provider.baseUrl : provider.baseUrl + '/');
  const upstreamRequests = new Set();
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', part => chunks.push(part));
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const url = new URL(request.url.replace(/^\//, ''), endpoint);
      const id = 'relay-' + randomUUID();
      let body; try { body = JSON.parse(bytes.toString()); } catch { body = bytes.toString(); }
      appendFileSync(join(variantRoot, 'fetch.jsonl'), redact(JSON.stringify({ time: Date.now(), event: 'request', id, kind: 'model', url: url.href, body, transparentRelay: true })) + '\n', { mode: 0o600 });
      const headers = { ...request.headers, host: url.host }; delete headers.connection;
      const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: request.method, headers }, result => {
        appendFileSync(join(variantRoot, 'fetch.jsonl'), JSON.stringify({ time: Date.now(), event: 'response', id, status: result.statusCode }) + '\n');
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstreamRequests.add(upstream);
      upstream.once('close', () => upstreamRequests.delete(upstream));
      response.once('close', () => upstream.destroy());
      upstream.on('error', error => { response.writeHead(502); response.end(JSON.stringify({ error: { message: error.message } })); });
      upstream.end(bytes);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => {
    for(const upstream of upstreamRequests) upstream.destroy();
    server.close(resolve); server.closeAllConnections();
  }) };
}
async function command(args, env, output, timeout = 240000) {
  const child = spawn(process.execPath, [settings.openclawCli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer); save(output + '.stdout', stdout); save(output + '.stderr', stderr);
  let parsed;
  try { parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch {}
  return { code, stdout, stderr, parsed };
}
function analyze(variant, label, start, cliResult, transport) {
  const traffic = lines(join(root, variant, 'fetch.jsonl')).filter(row => row.time >= start);
  const host = lines(join(root, variant, 'host.jsonl')).filter(row => row.time >= start);
  const modelRequests = traffic.filter(row => row.event === 'request' && row.kind === 'model' &&
    JSON.stringify(row.body.messages?.filter(m => ['system', 'developer'].includes(m.role))).includes('PR177_RECEIVER_AGENT'));
  const receiverFirst = modelRequests.find(row => JSON.stringify(row.body.messages).includes(caseTag(label)));
  const searches = traffic.filter(row => row.event === 'request' && /\/search\/memory$/.test(row.url) && row.body?.query?.includes(caseTag(label)));
  const realRecallHasAnswer = searches.some(search => traffic.some(row => row.id === search.id && row.event === 'response-body' && JSON.stringify(row.body?.data).includes(answer)));
  const systemMessages = receiverFirst?.body.messages.filter(m => ['system', 'developer'].includes(m.role)) ?? [];
  const userMessages = receiverFirst?.body.messages.filter(m => m.role === 'user') ?? [];
  const sends = host.filter(row => row.event === 'after_tool_call' && row.data.toolName === 'sessions_send');
  const targetSession = 'agent:receiver:' + label;
  const output = host.find(row => row.event === 'llm_output' && row.sessionKey === targetSession);
  const receiverInput = host.find(row => row.event === 'before_prompt_build' && row.sessionKey === targetSession);
  const result = { variant, label, transport, exitCode: cliResult.code,
    receiverProviderRequests: modelRequests.length, realRecallHasAnswer,
    receiverWireHasAnswer: JSON.stringify(receiverFirst?.body.messages ?? []).includes(answer),
    receiverSystemHasAnswer: JSON.stringify(systemMessages).includes(answer),
    receiverUserHasAnswer: JSON.stringify(userMessages).includes(answer),
    receiverHasOriginEnvelope: JSON.stringify(receiverFirst?.body.messages ?? []).includes('[Inter-session message]'),
    senderActuallyCalledSessionsSend: sends.length > 0,
    successfulSessionsSendCalls: sends.filter(row => row.data.result?.details?.status === 'ok').length,
    receiverOrigin: receiverInput?.inputProvenance,
    receiverAnswer: output?.data.assistantTexts?.join('\n'),
    receiverAnsweredCorrectly: output?.data.assistantTexts?.join('\n').trim() === answer,
    receiverWireAnswerOccurrences: (JSON.stringify(receiverFirst?.body.messages ?? []).split(answer).length - 1),
    toolCalls: sends.map(row => row.data), receiverOutput: output?.data,
    searchesUseReceiver: searches.length > 0 && searches.every(row => row.body.user_id === userId && JSON.stringify(row.body.filter).includes('receiver')),
    evidence: { fetch: join(root, variant, 'fetch.jsonl'), host: join(root, variant, 'host.jsonl') } };
  report.cases.push(result); persist(); progress({ case: label, variant, exitCode: result.exitCode, recall: realRecallHasAnswer,
    wireMemory: result.receiverWireHasAnswer, systemMemory: result.receiverSystemHasAnswer, sessionsSend: result.senderActuallyCalledSessionsSend });
  return result;
}
async function runVariant(variant, source) {
  const variantRoot = join(root, variant), state = join(variantRoot, 'state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const plugin = join(variantRoot, 'plugin'); cpSync(source, plugin, { recursive: true, filter: path => !path.includes('/node_modules') && !path.includes('/.git') });
  const probe = join(variantRoot, 'probe'); mkdirSync(probe);
  cpSync(join(fixtures, 'live-host-probe.mjs'), join(probe, 'index.mjs'));
  writeFileSync(join(probe, 'openclaw.plugin.json'), JSON.stringify({ id: 'memos-live-host-probe', configSchema: { type: 'object', properties: {}, additionalProperties: false } }));
  const senderWorkspace = join(variantRoot, 'sender'), receiverWorkspace = join(variantRoot, 'receiver');
  for(const path of [senderWorkspace, receiverWorkspace]) mkdirSync(path);
  writeFileSync(join(senderWorkspace, 'AGENTS.md'), 'PR177_SENDER_AGENT. This is an isolated regression. Follow the user request by calling sessions_send exactly once, then report the peer response. Never use other tools.');
  writeFileSync(join(receiverWorkspace, 'AGENTS.md'), 'PR177_RECEIVER_AGENT. This is an isolated regression. Answer the requested test code only from MemOS memory supplied in this turn. When absent answer UNKNOWN. Never guess, call tools, or send messages.');
  const port = await freePort(); const gatewayToken = randomBytes(24).toString('hex'); secrets.push(gatewayToken);
  const relay = await modelRelay(variantRoot);
  const modelConfig = { ...provider, baseUrl: relay.baseURL, apiKey: '${PR177_MODEL_API_KEY}', agentRuntime: { id: 'openclaw' }, models: provider.models.filter(item => item.id === model) };
  const config = { models: { mode: 'replace', providers: { 'regression-live': modelConfig } },
    agents: { ownership: 'explicit', defaults: { model: 'regression-live/' + model, models: { ['regression-live/' + model]: { agentRuntime: { id: 'openclaw' }, codeMode: false } },
      skipBootstrap: true, thinkingDefault: 'off', timeoutSeconds: 180, skills: [] },
      entries: { sender: { workspace: senderWorkspace, tools: { allow: ['sessions_send'] } }, receiver: { workspace: receiverWorkspace, tools: { deny: ['*'] } } } },
    tools: { codeMode: { enabled: false }, sessions: { visibility: 'all' }, agentToAgent: { enabled: true, allow: ['sender', 'receiver'] } },
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' }, reload: { mode: 'off' } },
    plugins: { allow: ['memos-cloud-openclaw-plugin', 'memos-live-host-probe'], load: { paths: [plugin, probe] }, slots: { memory: 'none' }, entries: {
      'memos-cloud-openclaw-plugin': { enabled: true, hooks: { allowConversationAccess: true }, config: {
        baseUrl: memoryURL, apiKey: '${MEMOS_API_KEY}', userId, recallEnabled: true, addEnabled: false, rumEnabled: false,
        multiAgentMode: true, allowedAgents: ['receiver'], recallGlobal: true, relativity: 0, memoryLimitNumber: 25,
        includePreference: false, includeToolMemory: false, recallFilterEnabled: false, timeoutMs: 60000, retries: 0,
      } }, 'memos-live-host-probe': { enabled: true, hooks: { allowConversationAccess: true } },
    } }, hooks: { internal: { enabled: false } } };
  if(settings.hostConfigDialect === 'agents-list') {
    config.agents.list = Object.entries(config.agents.entries).map(([id, entry]) => ({ id, ...entry, ...(id === 'sender' ? { default: true } : {}) }));
    delete config.agents.entries; delete config.agents.ownership;
    for(const entry of Object.values(config.agents.defaults.models)) delete entry.codeMode;
    config.session = { agentToAgent: { maxPingPongTurns: 0 } };
  }
  const configPath = join(state, 'openclaw.json'); writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  const env = { ...process.env, MEMOS_API_KEY: memosKey, PR177_MODEL_API_KEY: modelKey,
    OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    MEMOS_OPENCLAW_LIVE_FETCH_LOG: join(variantRoot, 'fetch.jsonl'), MEMOS_OPENCLAW_LIVE_HOST_LOG: join(variantRoot, 'host.jsonl'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + join(fixtures, 'live-fetch-observer.mjs')].filter(Boolean).join(' '),
  };
  delete env.MEMOS_USER_ID;
  const validation = await command(['config', 'validate'], env, variant + '/validate', 90000);
  if(validation.code !== 0) { await relay.close(); throw new Error(`Isolated ${variant} config validation failed; inspect ${variant}/validate.stderr.`); }
  const gateway = spawn(process.execPath, [settings.openclawCli, 'gateway', 'run', '--port', String(port)], { cwd: variantRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let gatewayStdout = '', gatewayStderr = '';
  gateway.stdout.on('data', part => { gatewayStdout += part; }); gateway.stderr.on('data', part => { gatewayStderr += part; });
  const gatewayClosed = new Promise(resolve => gateway.once('close', resolve));
  try {
    let ready = false;
    for(let attempt = 0; attempt < 120; attempt++) {
      if(gateway.exitCode !== null) break;
      try { const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }); if(response.ok) { ready = true; break; } } catch {}
      await pause(500);
    }
    save(variant + '/gateway.stdout', gatewayStdout); save(variant + '/gateway.stderr', gatewayStderr);
    assert.ok(ready, `${variant} isolated gateway did not start.`);
    progress({ variant, gatewayReady: true, port });
    let start = Date.now();
    const direct = await command(['agent', '--agent', 'receiver', '--session-key', 'agent:receiver:direct-control', '--message', caseQuestion('direct-control'), '--json'], env, variant + '/direct');
    await pause(300);
    const control = analyze(variant, 'direct-control', start, direct, 'ordinary-agent');
    assert.equal(control.exitCode, 0); assert.equal(control.realRecallHasAnswer, true); assert.equal(control.receiverWireHasAnswer, true);
    assert.equal(control.receiverAnsweredCorrectly, true, 'The ordinary recall positive control must answer the real code.');
    for(let round = 1; round <= (settings.repetitions ?? 2); round++) {
      const target = `agent:receiver:inter-${round}`;
      // Create an empty real Gateway session without a model turn or recalled
      // history, so the only possible source of the answer is this turn's MemOS recall.
      const created = await command(['gateway', 'call', 'sessions.patch', '--params', JSON.stringify({ key: target, label: 'PR177 isolated receiver ' + round }), '--json'], env, variant + '/create-inter-' + round);
      assert.equal(created.code, 0, 'Create a fresh receiving session before sessions_send.');
      assert.equal(created.parsed?.ok, true); assert.ok(created.parsed?.entry?.sessionId);
      start = Date.now();
      const argumentsJson = JSON.stringify({ sessionKey: target, message: caseQuestion('inter-' + round), timeoutSeconds: 120 });
      const prompt = `Call sessions_send exactly once using this exact JSON arguments object: ${argumentsJson}. Copy the entire message string including its delivery-case identifier. Do not answer the question yourself. After receiving the peer result, output that result immediately.`;
      const response = await command(['agent', '--agent', 'sender', '--session-key', `agent:sender:send-${round}`, '--message', prompt, '--json'], env, variant + '/inter-' + round);
      await pause(500);
      const result = analyze(variant, 'inter-' + round, start, response, 'model-tool-sessions_send');
      assert.equal(result.exitCode, 0); assert.equal(result.senderActuallyCalledSessionsSend, true, 'The real sender must call sessions_send.');
      assert.equal(result.successfulSessionsSendCalls, 1, 'The sessions_send tool must complete successfully exactly once.');
      assert.ok(result.toolCalls.every(call => !call.params.message.includes(answer) && call.params.message.includes(caseTag('inter-' + round))), 'Send only the case-specific question, never the seeded answer.');
      if(settings.requireInputProvenance !== false) {
        assert.equal(result.receiverOrigin?.kind, 'inter_session');
        assert.equal(result.receiverOrigin?.sourceTool, 'sessions_send');
      }
      assert.equal(result.realRecallHasAnswer, true, 'The real MemOS response must contain the seeded code.');
      assert.ok(result.receiverProviderRequests > 0, 'Capture the actual receiver model request.');
      assert.equal(result.receiverHasOriginEnvelope, true, 'Preserve host-owned inter-session provenance.');
      assert.equal(result.searchesUseReceiver, true, 'Keep retrieval user identity and receiving agent filter.');
      if(variant === 'baseline' && settings.expectedBaselineMemory !== undefined) {
        assert.equal(result.receiverWireHasAnswer, settings.expectedBaselineMemory === 'present', 'Historical baseline wire memory matches the expected boundary.');
        if(settings.expectedBaselineMemory === 'present') assert.equal(result.receiverAnsweredCorrectly, true);
      }
      if(variant === 'candidate') {
        assert.equal(result.receiverSystemHasAnswer, candidatePlacement === 'system', 'Candidate system memory placement matches the host policy.');
        assert.equal(result.receiverUserHasAnswer, candidatePlacement === 'prepend', 'Candidate user memory placement matches the host policy.');
        assert.equal(result.receiverWireAnswerOccurrences, 1, 'Do not inject the same code twice.');
        assert.equal(result.receiverAnsweredCorrectly, true, 'The receiving real model must answer the seeded code.');
      }
    }
  } finally {
    gateway.kill('SIGTERM'); await Promise.race([gatewayClosed, pause(10000)]);
    if(gateway.exitCode === null) { gateway.kill('SIGKILL'); await gatewayClosed; }
    save(variant + '/gateway.stdout', gatewayStdout); save(variant + '/gateway.stderr', gatewayStderr);
    await relay.close();
  }
}
try {
  await seed();
  for(const variant of selectedVariants) {
    const source = variant === 'baseline' ? settings.basePlugin : settings.candidatePlugin;
    try { await runVariant(variant, source); }
    catch(error) { report.failures.push({ variant, error: redact(error.stack) }); persist(); progress({ variant, failed: error.message }); }
  }
  const base = report.cases.filter(item => item.variant === 'baseline' && item.transport === 'model-tool-sessions_send');
  const candidate = report.cases.filter(item => item.variant === 'candidate' && item.transport === 'model-tool-sessions_send');
  report.conclusion = { baselineLosesMemory: base.length > 0 && base.every(item => item.realRecallHasAnswer && !item.receiverWireHasAnswer),
    candidatePreservesMemory: candidate.length > 0 && candidate.every(item => item.realRecallHasAnswer && item.receiverWireHasAnswer && (candidatePlacement === 'system' ? item.receiverSystemHasAnswer : item.receiverUserHasAnswer)),
    complete: report.failures.length === 0 && selectedVariants.every(name => report.cases.filter(item => item.variant === name && item.transport === 'model-tool-sessions_send').length === (settings.repetitions ?? 2)) };
  report.conclusion.verdict = !report.conclusion.complete ? 'incomplete' : report.conclusion.baselineLosesMemory && report.conclusion.candidatePreservesMemory
    ? 'baseline-loss-and-candidate-fix-confirmed' : base.every(item => item.receiverWireHasAnswer) && report.conclusion.candidatePreservesMemory
      ? 'baseline-loss-not-reproduced' : 'mixed-or-unfixed';
  if(report.conclusion.complete && !selectedVariants.includes('candidate')) report.conclusion.verdict = report.conclusion.baselineLosesMemory ? 'baseline-loss-confirmed' : base.every(item => item.receiverWireHasAnswer) ? 'baseline-loss-not-reproduced' : 'mixed-baseline';
  report.finished = new Date().toISOString(); persist(); progress({ conclusion: report.conclusion, results: join(root, 'results.json') });
  if(!report.conclusion.complete || (selectedVariants.includes('candidate') && !report.conclusion.candidatePreservesMemory)) process.exitCode = 1;
} catch(error) {
  report.failures.push({ error: redact(error.stack) }); persist(); progress({ failed: error.message, results: join(root, 'results.json') }); process.exitCode = 1;
}
