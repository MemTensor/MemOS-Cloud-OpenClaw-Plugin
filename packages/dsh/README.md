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
DSH supplies the matching host SDK packages. See [Compatibility](#compatibility) for supported hosts.

### Option A — NPM (Recommended)

```powershell
dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

If DSH is not installed globally:

```powershell
npx @deepseek-ai/dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

### Option B — Package from Source

Node.js 24.9+ is recommended for source builds. The installed plugin's runtime requirements are listed under [Compatibility](#compatibility).

Run from the monorepo repository root. Install the workspace dependencies, then create the versioned `.tgz`; packaging does not add the plugin to DSH. The development SDK versions and lockfile pin a tested build baseline; the installed plugin uses the SDK supplied by its host.

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

In a profile with credential storage enabled (such as current Web, SDK, or ACP), you can store the API key in **`~/.dsh/.credentials.yaml`** under `refs`. Add it to the existing mapping and preserve other credentials and `records`:

```yaml
version: 1
refs:
  MEMOS_API_KEY: mpg-your-key
records: {}
```

On macOS and Linux, restrict this credentials file to mode `0600`; current hosts reject files readable by other users.

The current default headless profile disables credential storage; supply its key through the launch environment or `.env`. To use saved credentials there, explicitly restore the host's credential storage configuration. Host upgrades can change credential precedence; see the [DSH credential upgrade guide](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/upgrade-guide/v0.2.1-alpha.2/stored-credentials-precedence/guide.md).

Configure the user ID using either `MEMOS_USER_ID` in `.env` or `userId` in the Settings / profile configuration described below (`settings.yaml` on earlier hosts).

### 2. Plugin Settings

On hosts with Settings forms, edit `memos-cloud` in Settings. Values persist in the active profile's `cordis.patch.yml`, for example:

```yaml
- id: memos-cloud
  config:
    apiKeyEnv: MEMOS_API_KEY
    userId: your-stable-user-id
```

Earlier hosts still use **`~/.dsh/settings.yaml`**:

**Minimal config**

```yaml
memos-cloud:
  apiKeyEnv: MEMOS_API_KEY
```

Keep credentials in `.env` as above; edit ordinary options in Settings or the configuration file for your host version.

When upgrading to a host with Settings forms, the plugin migrates its section of `settings.yaml` and can recover it from `settings.yaml.imported`. Explicit values in the active profile take precedence. Other plugins' sections and comments are preserved.

Before removing the global section, the plugin saves a shared `memos-cloud.legacy.json` under `DSH_HOME` (default `~/.dsh`) so other profiles can migrate later. Each migrating profile keeps its own backup and records completion in `memos-cloud.migration.json`. Completing one profile keeps the shared archive; its completion marker prevents re-importing the same legacy snapshot after a restart or Settings reset.

If the global section and shared archive are already gone, the plugin can recover preserved backups under `DSH_HOME/profiles`. Recovery from other profiles stops if their backups disagree. A failed migration skips this plugin's memory requests until the configuration is fixed and the host restarted. Backup files use mode `0600` on POSIX systems; protect them as credentials files because they may contain a legacy API key.

**Configuration precedence**

| Option and scenario | Precedence, highest first |
| --- | --- |
| API key: current host with credential storage enabled | Explicit `apiKey` → matching `refs` entry in `.credentials.yaml` → inherited process environment → launch-directory `.env` → `DSH_HOME/.env` |
| API key: current default headless, without credential storage | Explicit `apiKey` → inherited process environment → launch-directory `.env` → `DSH_HOME/.env` |
| User ID | Explicit `userId` → `MEMOS_USER_ID` in the launch environment (process → launch-directory `.env` → `DSH_HOME/.env`) → `deepseek-harness-user` |
| Other ordinary options | Explicit Settings / profile values (`settings.yaml` on earlier hosts) → plugin defaults |

Set `apiKeyEnv` to the credential name (default: `MEMOS_API_KEY`), used for both the credential reference and the matching environment variable. The credentials file does not supply a user ID or other ordinary options. The plugin calls the host's `credentials.resolve()` first, falling back to the launch environment only when no non-empty key resolves. Older host providers may still prioritize the environment over storage; the plugin follows their rules. On current hosts with a saved key for that reference, changing the environment alone does not override it; update or remove the saved reference.

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

When `multiAgentMode` is enabled, both search and add use the session's current preset as `agent_id`, so switching presets also switches the memory partition. The plugin prefers the host's `agentPresets.presetForSession(session)` API. When that service or method is unavailable, it tries `sessionProjections.stateOf(session, 'agentPreset')`. If neither read is available, the legacy projection is unregistered, or the selected read throws, it falls back to `session.header.agentPreset`, which contains the initial preset. An explicit `null` from the modern API or a cleared legacy projection never revives a stale projection or header value. DSH deployments such as the headless profile may create sessions without a preset; those sessions use the explicitly configured `agentId`, or omit `agent_id` when no fallback is configured. A subagent joined to its parent's preset shares that preset-level memory partition while keeping its own `conversation_id`.

Because the preset selects `agent_id` per Session, do not also set a fixed `agent_id` inside `filter` when `multiAgentMode` is enabled; configuration validation rejects that conflicting combination.

## Compatibility

- Supported host series: `0.1.x` (starting at `0.1.0-rc.6`) and `0.2.x`, declared as `engines.dsh: >=0.1.0-rc.6 <0.3.0-0`
- Full DSH CLI installations: `0.1.7-rc.2`, `0.2.1-rc.2`, and `0.2.1-rc.4`
- Workspace build and development SDK baseline: `0.2.1-rc.2`; legacy SDK behavior and type checks also cover `0.1.0-rc.6` and `0.1.7-rc.2`
- Profile package managers: pnpm `11.9.0` and `12.11.2`
- Plugin Node.js declaration: `^22.19.0 || >=24.0.0`, retaining Node 22 support for older hosts; the host's own requirement also applies
- Hosts adopting the [DSH Node 24 upgrade](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/upgrade-guide/v0.2.1-rc.2/node-24/guide.md) require Node.js ≥24.9.0; CI uses Node 22.19+ (22.x) for legacy hosts and Node 24.9+ (24.x) for the workspace baseline and `0.2.x` hosts
- MemOS Cloud API: `/api/openmem/v1`

Maintenance policy: one plugin release supports both host series. Each release runs regressions on old and new hosts and on upgrades between them. Host updates within these series do not need individual allowlist entries; new SDK usage must retain old-host adapters or capability checks. Dropping `0.1.x` or adding `0.3.x` support requires a new plugin release, compatibility declaration, and migration instructions. Never silently change an existing package. The range is a maintenance commitment; the concrete versions above are regression samples, not evidence that every future host has already been tested.

## Security and Privacy

- Recall JSON escapes `<` and is labeled untrusted, read-only background data.
- Instructions, permission claims, and tool requests inside memory are never executed by the plugin.
- The plugin never uploads cwd, full configuration, system prompts, reasoning, plugin-injected context, or attachment bytes. Tool arguments and textual results are uploaded only when `includeToolMemory` is enabled; non-text results use an omission marker, and an over-budget argument omits its whole correlated tool pair instead of emitting invalid JSON.
- Original DSH message IDs and event timestamps are preserved.
- Public writes remain disabled unless `allowPublic` is explicitly enabled.
- Warnings omit API keys, authorization headers, and request bodies.

## Installation and upgrade policy

`engines.dsh` declares the supported host series. DSH versions implementing it give it precedence; older hosts fall back to DSH SDK peers. SDK peers cover stable `0.1.x` and `0.2.x` releases and include prerelease ranges for known RC baselines to satisfy standard npm/pnpm semver matching. DSH enables `includePrerelease` for its host gate; package managers normally admit prereleases only at the version baselines named in their ranges, so the two checks are tested separately.

| Scenario | Procedure and expected result |
| --- | --- |
| Install the current plugin on DSH `0.1.x` | Run `dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest` with the existing host; installation, startup, and memory operations work |
| Install the current plugin on DSH `0.2.x` | Use the same plugin artifact, without extra SDK installations or compatibility exemptions |
| Upgrade `0.1.x` to `0.2.x` with the current plugin already installed | Keep `DSH_HOME` and the profile, upgrade the complete DSH distribution, and restart; no plugin reinstall is required |
| Upgrade an older plugin and a `0.1.x` host | Prefer updating the plugin on the old host and verifying it before upgrading DSH |
| The host was upgraded first and now rejects the old plugin | Use the new host's `dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest` to update in place before startup; the CLI update does not need to boot the old plugin |

Update in place with the same `add` command used for installation, without a preceding `remove`. Keep `DSH_HOME` (default `~/.dsh`), the profile name, `.env`, and `cordis.patch.yml`, especially `userId` and `agentId`, to retain the memory partition. Back up that directory and retain the previous plugin artifact for rollback. Do not reset an existing profile with `--from-default-profile`.

For a source artifact, first build the tarball using Option B. From the repository root, run this on the existing `0.1.x` host:

```powershell
dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

Restart and verify the old host, then upgrade the complete DSH installation and run `dsh web` with the same `DSH_HOME`. If the host was upgraded first, the same `add` command can update the plugin directly. Compatibility of old releases is determined by their own manifests; a new plugin cannot rewrite historical packages and does not require the host to reject every old package.

Use `dsh plugin add` to enable the plugin in a profile. Installing the package with npm or pnpm in an empty project and importing its definition in Node.js also works: host SDKs are optional peers loaded only when the plugin runs. This standalone import does not activate memory functionality; execution requires the complete DSH host to supply one coherent SDK. Do not install `dsh-scope` or other SDK pieces independently or use compatibility exemptions instead of updating.

## Shutdown and regression checks

Writes enqueue at `turn/end`. The awaited `session/flush` checkpoint drains the current session before headless requests exit. Its bounded budget is at least 15 seconds and accounts for each queued request's effective write timeout, retries, and per-session ordering; unrelated sessions remain parallel. Settings edits to modes or timeouts affect newly enqueued requests. Disposal stops new work, cancels recall, and drains writes with an explicit warning on timeout. Signal shutdown remains subject to DSH's own five-second teardown limit, and forced termination cannot guarantee delivery. With `asyncMode: true`, a successful response confirms server acceptance; search visibility depends on cloud processing.

Run behavior tests with `pnpm --filter @memtensor/memos-cloud-dsh-plugin test`. Set `DSH_TEST_RUNTIME` to an isolated installation directory to run that suite and `pnpm --filter @memtensor/memos-cloud-dsh-plugin test:types` against another SDK.

For an existing tarball, set `DSH_TEST_PACKAGE` to its absolute path and run `pnpm --filter @memtensor/memos-cloud-dsh-plugin test:standalone` to check npm/pnpm installation and Node.js import without a host. For real CLI installation, shared host SDK resolution, Settings, migration, recall, tool capture, and shutdown checks, also set `DSH_TEST_RUNTIME` to the full installation directory containing `node_modules/@deepseek-ai/dsh`, then run `pnpm --filter @memtensor/memos-cloud-dsh-plugin test:host`. HTTP endpoints in this smoke are local fixtures.

To pack and run both checks together, set `DSH_TEST_RUNTIME` as above and run `pnpm exec node scripts/verify-package-artifacts.mjs --plugin dsh` from the repository root.

Set `DSH_TEST_PNPM` to the package-manager executable to test and `DSH_TEST_PNPM_VERSION` to its expected version. The smoke checks both that executable and the profile installation output, independently of the workspace's build pnpm. Set `DSH_TEST_UPGRADE_FROM` to an older full DSH installation to test reusing the current plugin across a host upgrade, updating the plugin before upgrading the host, and updating in place after upgrading the host. Each path checks Settings preservation and the actual installed version. By default, the previous plugin is a distinct, `0.1.x`-only fixture built from the same code to test package replacement and configuration preservation. With `DSH_TEST_UPGRADE_PACKAGE` set to a historical release tarball, the smoke installs that package and saves its profile config before checking the actual update, configuration preservation, and updated plugin behavior. It neither requires the historical package to implement current Settings forms or shutdown behavior nor certifies its runtime behavior. CI covers both package-manager versions and upgrades from `0.1.7-rc.2` to `0.2.1-rc.4`.

For opt-in real integration testing, run `node packages/dsh/scripts/live-regression.mjs /absolute/config.json all`. The non-secret config supplies `root`, `runtimes.old` / `runtimes.target`, a `plugin` tarball, `modelURL` / `model` / `modelKeyEnv`, `memoryURL`, and credential `envFiles` paths. The script creates isolated profiles and users, calls the actual model and MemOS endpoints, and saves redacted request/response timing and upgrade evidence.
