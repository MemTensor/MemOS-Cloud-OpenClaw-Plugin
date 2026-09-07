# MemOS Cloud DeepSeek Harness Plugin (Lifecycle)

Official plugin maintained by MemTensor.

[English](README.md) | [中文](README.zh.md)

A lifecycle bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that **recalls** relevant memories from MemOS Cloud before the model starts the current turn and **adds** the completed user/assistant turn back to MemOS Cloud afterward.

## Features

- **Recall**: before the first model step of every user turn → `/search/memory`
- **Add**: after that turn ends with `completed` → `/add/message`
- **Deterministic filters**: user, public, knowledge-base, metadata, tags, and static or preset-based agent isolation
- **Lifecycle-native**: memory is automatic; the model does not decide whether to call a memory tool
- **Fail-open**: MemOS errors never interrupt the Harness turn
- **Safe capture**: excludes system prompts, reasoning, attachments, and plugin context; tool calls/results are included only when `includeToolMemory` is enabled
- Uses **Token** auth (`Authorization: Token <MEMOS_API_KEY>`)

## Install

The following commands install the plugin into DeepSeek Harness's default `web` profile.

### Option A — NPM (Recommended)

```powershell
dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

If DSH is not installed globally:

```powershell
npx @deepseek-ai/dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

### Option B — Package from Source

Run from the monorepo repository root. Install the workspace dependencies, then create the versioned `.tgz`; packaging does not add the plugin to DSH.

```powershell
pnpm install --frozen-lockfile
pnpm pack:dsh
dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

If DSH is not installed globally:

```powershell
npx @deepseek-ai/dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

The install command derives the tarball filename from `packages/dsh/package.json`, so it remains valid after a version change. `lib/` is build output; the installable package is the `.tgz` file under `artifacts/`.

### Remove

```powershell
dsh plugin --profile web remove @memtensor/memos-cloud-dsh-plugin
```

If DSH is not installed globally:

```powershell
npx @deepseek-ai/dsh plugin --profile web remove @memtensor/memos-cloud-dsh-plugin
```

## Start or Restart DSH Web

After installing or removing the plugin, restart DSH Web to reload the `web` profile. If it is already running, press `Ctrl+C` in its terminal, then start it again:

```powershell
npx @deepseek-ai/dsh web
```

## Configuration

### 1. API Key Credential

Create a MemOS API key at [MemOS Dashboard](https://memos-dashboard.openmem.net/cn/apikeys/).

DSH credential file: **`~/.dsh/.credentials.yaml`**

Add the API key:

```yaml
MEMOS_API_KEY: mpg-your-key
```

### 2. Plugin Settings

DSH plugin settings file: **`~/.dsh/settings.yaml`**

**Minimal config**

```yaml
memos-cloud:
  apiKeyEnv: MEMOS_API_KEY
```

**Optional config**

- `apiKeyEnv` (default: `MEMOS_API_KEY`; Harness credential reference)
- `baseURL` (default: `https://memos.memtensor.cn/api/openmem/v1`; MemOS API root)
- `userId` (default: `MEMOS_USER_ID`, then `deepseek-harness-user`; stable shared read/write user namespace)
- `recallEnabled` (default: `true`; search before the first model step of each user turn)
- `addEnabled` (default: `true`; add after the current turn ends with `completed`)
- `includeAssistant` (default: `true`; include assistant text in add)
- `includeSubagents` (default: `false`; process sessions with `origin: subagent`)
- `multiAgentMode` (default: `false`; use the stable DSH `agentPreset` as `agent_id`, falling back to `agentId` when no preset exists)
- `queryPrefix` (default: empty; text prepended to every recall query)
- `recallGlobal` (default: `false`; omit `conversation_id` and search the user's memories globally)
- `memoryLimitNumber` (default: `6`; factual result limit, `1..25`)
- `preferenceLimitNumber` (default: `6`; preference result limit, `1..25`)
- `includePreference` (default: `true`; recall preference memories)
- `includeToolMemory` (default: `false`; recall tool memories and add correlated tool calls/results)
- `toolMemoryLimitNumber` (default: `6`; tool-memory result limit, `1..25`)
- `relativity` (default: `0.45`; semantic threshold, `0..1`)
- `filter` (optional; ordinary or per-source deterministic filter)
- `knowledgebaseIds` (default: `[]`; KB IDs to search; `all` cannot be mixed with concrete IDs)
- `tags` (default: `[deepseek-harness]`; tags for add)
- `info` (default: `{}`; non-blank string metadata)
- `agentId` (optional; add `agent_id` and constrain the user search branch)
- `appId` (optional; add `app_id`; not an automatic search filter)
- `allowKnowledgebaseIds` (default: `[]`; KB IDs allowed for writes)
- `maxQueryChars` (default: `4000`; search query character budget)
- `maxRecallChars` (default: `12000`; total recalled-text budget)
- `maxItemChars` (default: `2000`; per-item recalled-text budget)
- `maxMessageChars` (default: `12000`; per-message add budget)
- `timeoutMs` (default: `5000`; HTTP timeout, `100..60000` ms)
- `searchRetries` (default: `1`; extra search attempts, `0..3`)
- `addRetries` (default: `0`; extra add attempts, `0..3`)
- `allowPublic` (default: `false`; allow generated memories to enter the public project store)
- `asyncMode` (default: `true`; ask MemOS to process added messages asynchronously)

## How It Works

- **Recall** (`agent/pre-step`): on the first model step of each direct user turn, the plugin calls `/search/memory` and inserts the results before the user message.
- **Add** (`turn/end`): after a turn ends with `completed`, the plugin sends the user text, optional assistant text, and—when enabled—correlated tool calls/results to `/add/message`.
- MemOS failures do not interrupt the Harness turn. Subagent sessions are excluded unless `includeSubagents` is enabled.

### Shared MemOS API behavior

The private workspace core is also used by the OpenClaw adapter. DSH therefore uses the same `Authorization: Token` client, request validation, filter construction, timeout handling, retry bounds, safe serialization, response validation, and MemOS tool-message wire types. Search can request factual memories with `memoryLimitNumber`, preferences with `includePreference` and `preferenceLimitNumber`, and tool memories with `includeToolMemory` and `toolMemoryLimitNumber`. The response projector keeps these categories separate before DSH inserts the resulting untrusted JSON context.

`knowledgebaseIds` and `filter` constrain `/search/memory`. `tags`, `info`, `agentId`, `appId`, `allowKnowledgebaseIds`, `asyncMode`, and `allowPublic` are applied to `/add/message` when configured. `maxQueryChars`, `maxRecallChars`, `maxItemChars`, and `maxMessageChars` bound text before it crosses the MemOS or host boundary. `searchRetries` and `addRetries` remain independently configurable because recall and write failures have different host impact.

### DSH adapter boundary

The shared core does not contain DSH lifecycle code. This package alone owns the Cordis credential/settings services, `agent/pre-step` and `turn/end` subscriptions, session-to-conversation mapping, DSH message/tool conversion, preset-based agent attribution, capture policy, prompt insertion, and serialized write queue. OpenClaw-only configuration UI, per-agent overrides, and model-based second-pass recall filtering are not implied by the shared MemOS API layer.

When `multiAgentMode` is enabled, both search and add use `session.header.agentPreset` as `agent_id`. DSH deployments such as the headless profile may create sessions without a preset; those sessions use the explicitly configured `agentId`, or omit `agent_id` when no fallback is configured. A subagent joined to its parent's preset shares that preset-level memory partition while keeping its own `conversation_id`.

Because the preset selects `agent_id` per Session, do not also set a fixed `agent_id` inside `filter` when `multiAgentMode` is enabled; configuration validation rejects that conflicting combination.

## Compatibility

- DeepSeek Harness: `0.1.0-rc.6`
- Node.js: `^22.19.0 || >=24.0.0`
- MemOS Cloud API: `/api/openmem/v1`

Harness is a developer preview. Re-run the full tests and a live smoke after upgrading it.

## Security and Privacy

- Recall JSON escapes `<` and is labeled untrusted, read-only background data.
- Instructions, permission claims, and tool requests inside memory are never executed by the plugin.
- The plugin never uploads cwd, full configuration, system prompts, reasoning, plugin-injected context, or attachment bytes. Tool arguments and textual results are uploaded only when `includeToolMemory` is enabled; non-text results use an omission marker, and an over-budget argument omits its whole correlated tool pair instead of emitting invalid JSON.
- Original DSH message IDs and event timestamps are preserved.
- Public writes remain disabled unless `allowPublic` is explicitly enabled.
- Warnings omit API keys, authorization headers, and request bodies.
