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

### 1. API Key and User ID via `.env` (Recommended)

Create a MemOS API key at [MemOS Dashboard](https://memos-dashboard.openmem.net/cn/apikeys/).

Create or edit **`~/.dsh/.env`** in the DSH configuration directory:

```dotenv
MEMOS_API_KEY=mpg-your-key
MEMOS_USER_ID=your-stable-user-id
```

Use a stable, distinct `MEMOS_USER_ID` for each user's memories. The plugin uses this same ID for both recall and add. If it is omitted, the default is `deepseek-harness-user`.

DSH reads `~/.dsh/.env` by default. It also reads `.env` from the directory where you run the `dsh` command, which takes precedence.

Restart DSH after changing `.env`; its environment values are loaded at startup.

Alternatively, store the API key in **`~/.dsh/.credentials.yaml`** under `refs`. Add it to the existing mapping and preserve other credentials and `records`:

```yaml
version: 1
refs:
  MEMOS_API_KEY: mpg-your-key
records: {}
```

Configure the user ID using either `MEMOS_USER_ID` in `.env` or `memos-cloud.userId` in `settings.yaml`, described below.

### 2. Plugin Settings

DSH `0.1.7-rc.2` / `0.2.1-rc.2`: edit `memos-cloud` in Settings. Values persist in the active profile's `cordis.patch.yml`, for example:

```yaml
- id: memos-cloud
  config:
    apiKeyEnv: MEMOS_API_KEY
    userId: your-stable-user-id
```

Earlier hosts (including `0.1.0-rc.6` and `0.1.2-rc.1`) still use **`~/.dsh/settings.yaml`**:

**Minimal config**

```yaml
memos-cloud:
  apiKeyEnv: MEMOS_API_KEY
```

Keep credentials in `.env` as above; edit ordinary options in Settings or the configuration file for your host version.

On upgrade, the plugin migrates its section of `settings.yaml` and recovers failed imports from `settings.yaml.imported`. Explicit values in the current profile take precedence. A private `memos-cloud.legacy.json` backup (mode `0600`) is saved in that profile before migration; `memos-cloud.migration.json` records completion so restarting does not resurrect old values after a Settings reset. Other plugins' sections and comments are preserved. A failed migration blocks memory requests until the configuration is fixed and the host restarted. Protect the backup as a credentials file; it may contain a legacy API key.

**Configuration precedence**

For an option with multiple supported sources, precedence is, highest first: explicit Settings / profile values (`settings.yaml` on earlier hosts) → inherited process environment → credentials in `~/.dsh/.credentials.yaml` → launch-directory `.env` → `~/.dsh/.env` → plugin defaults.

The credentials file applies only to the API key. Set `apiKeyEnv` to the credential name (default: `MEMOS_API_KEY`), and store the actual key in `.env` or `.credentials.yaml`.

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
- `searchTimeoutMs` (optional, default: `5000`; total recall budget including retries and credential lookup, `100..5000` ms)
- `syncAddTimeoutMs` (optional, default: `5000`; per-attempt write HTTP timeout only with `asyncMode: false`, `100..180000` ms)
- `timeoutMs` (legacy fallback, default: `5000`, `100..180000` ms; omitted new fields inherit this value. Recall and async writes cap it at `5000`; sync writes retain it. Explicit new fields take precedence)
- `searchRetries` (default: `1`; extra search attempts, `0..3`)
- `addRetries` (default: `0`; extra add attempts, `0..3`)
- `allowPublic` (default: `false`; allow generated memories to enter the public project store)
- `asyncMode` (default: `true`; ask MemOS to process added messages asynchronously)

To wait for synchronous cloud processing, use:

```yaml
searchTimeoutMs: 5000
asyncMode: false
syncAddTimeoutMs: 180000
```

Switching back to `asyncMode: true` ignores the retained `syncAddTimeoutMs`; async write attempts still take at most five seconds. Recall failure or budget expiry lets the model turn continue, with all `searchRetries` sharing the recall budget. A slow synchronous write does not extend recall, but its session waits for confirmation before normal exit. Existing short `timeoutMs` values keep their shorter limits, and legacy configurations require no field renaming.

## How It Works

- **Recall** (`agent/pre-step`): on the first model step of each direct user turn, the plugin calls `/search/memory` and inserts the results before the user message.
- **Add** (`turn/end`): after a turn ends with `completed`, the plugin sends the user text, optional assistant text, and—when enabled—correlated tool calls/results to `/add/message`.
- MemOS failures do not interrupt the Harness turn. Subagent sessions are excluded unless `includeSubagents` is enabled.

### Shared MemOS API behavior

The private workspace core is also used by the OpenClaw adapter. DSH therefore uses the same `Authorization: Token` client, request validation, filter construction, timeout handling, retry bounds, safe serialization, response validation, and MemOS tool-message wire types. Search can request factual memories with `memoryLimitNumber`, preferences with `includePreference` and `preferenceLimitNumber`, and tool memories with `includeToolMemory` and `toolMemoryLimitNumber`. The response projector keeps these categories separate before DSH inserts the resulting untrusted JSON context.

`knowledgebaseIds` and `filter` constrain `/search/memory`. `tags`, `info`, `agentId`, `appId`, `allowKnowledgebaseIds`, `asyncMode`, and `allowPublic` are applied to `/add/message` when configured. `maxQueryChars`, `maxRecallChars`, `maxItemChars`, and `maxMessageChars` bound text before it crosses the MemOS or host boundary. `searchRetries` and `addRetries` remain independently configurable because recall and write failures have different host impact.

### DSH adapter boundary

The shared core does not contain DSH lifecycle code. This package alone owns the Cordis credential/settings services, `agent/pre-step` and `turn/end` subscriptions, session-to-conversation mapping, DSH message/tool conversion, preset-based agent attribution, capture policy, prompt insertion, and serialized write queue. OpenClaw-only configuration UI, per-agent overrides, and model-based second-pass recall filtering are not implied by the shared MemOS API layer.

When `multiAgentMode` is enabled, both search and add use the current preset from the session's `agentPreset` projection as `agent_id`, so switching presets also switches the memory partition. Runtimes without an available projection fall back to `session.header.agentPreset`, which contains the initial preset. An explicitly cleared preset does not revive the old header value. DSH deployments such as the headless profile may create sessions without a preset; those sessions use the explicitly configured `agentId`, or omit `agent_id` when no fallback is configured. A subagent joined to its parent's preset shares that preset-level memory partition while keeping its own `conversation_id`.

Because the preset selects `agent_id` per Session, do not also set a fixed `agent_id` inside `filter` when `multiAgentMode` is enabled; configuration validation rejects that conflicting combination.

## Compatibility

- DeepSeek Harness: tested with `0.1.2-rc.1` and `0.1.0-rc.6`
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

## Compatibility and shutdown

DSH peers use `^0.1.0-rc.6 || ^0.1.2-rc.1 || ^0.2.1-rc.2`. Verification covers `0.1.0-rc.6`, `0.1.2-rc.1`, `0.1.7-rc.2`, and `0.2.1-rc.2`; later releases admitted by the range still need regression testing.

Writes enqueue at `turn/end`. The awaited `session/flush` checkpoint drains the current session before headless requests exit. Its bounded budget is at least 15 seconds and accounts for each queued request's effective write timeout, retries, and per-session ordering; unrelated sessions remain parallel. Settings edits to modes or timeouts affect newly enqueued requests. Disposal stops new work, cancels recall, and drains writes with an explicit warning on timeout. Signal shutdown remains subject to DSH's own five-second teardown limit, and forced termination cannot guarantee delivery. With `asyncMode: true`, a successful response confirms server acceptance; search visibility depends on cloud processing.

Run behavior tests with `pnpm --filter @memtensor/memos-cloud-dsh-plugin test`. Set `DSH_TEST_RUNTIME` to an isolated host installation to run that suite and `test:types` against another SDK. Also set `DSH_TEST_PACKAGE` to an absolute tarball path and run `test:host` for real CLI installation, Settings, migration, recall, tool capture, and shutdown checks using local HTTP fixtures.

For opt-in real integration testing, run `node packages/dsh/scripts/live-regression.mjs /absolute/config.json all`. The non-secret config supplies `root`, `runtimes.old` / `runtimes.target`, a `plugin` tarball, `modelURL` / `model` / `modelKeyEnv`, `memoryURL`, and credential `envFiles` paths. The script creates isolated profiles and users, calls the actual model and MemOS endpoints, and saves redacted request/response timing and upgrade evidence.
