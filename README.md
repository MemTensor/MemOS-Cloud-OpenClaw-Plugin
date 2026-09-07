# MemOS Cloud Host Plugins

[English](README.md) | [中文](README_ZH.md)

This pnpm monorepo maintains two MemOS Cloud lifecycle plugins with independent package versions and host adapters:

| Host | npm package | Detailed guide |
|---|---|---|
| OpenClaw | `@memtensor/memos-cloud-openclaw-plugin` | [`packages/openclaw/README.md`](packages/openclaw/README.md) |
| DeepSeek Harness (DSH) | `@memtensor/memos-cloud-dsh-plugin` | [`packages/dsh/README.md`](packages/dsh/README.md) |

Choose the package for your host. Users never install the private `packages/core` workspace directly; each public package contains the shared MemOS runtime it needs.

## Common MemOS Cloud Behavior

Both plugins use the current OpenClaw-compatible MemOS protocol implemented by the shared core:

- `Authorization: Token <MEMOS_API_KEY>` authentication;
- recall through `/search/memory`;
- message capture through `/add/message`;
- factual, preference, and tool-memory projection, including optional correlated tool-call/result capture;
- deterministic filters and knowledge-base scope;
- optional `agent_id`, `app_id`, tags, info, and allowed write knowledge bases;
- request validation, Unicode-safe truncation, timeouts, and bounded retries; and
- fail-open host integration so a MemOS error does not stop the agent turn.

The shared search settings include:

| Setting | Purpose |
|---|---|
| `memoryLimitNumber` | Maximum factual memories returned |
| `includePreference` / `preferenceLimitNumber` | Enable and limit preference recall |
| `includeToolMemory` / `toolMemoryLimitNumber` | Enable tool-call/result capture and limit tool-memory recall |
| `relativity` | Minimum semantic relevance |
| `knowledgebaseIds` | Restrict searchable knowledge bases |
| `recallGlobal` | Search without `conversation_id` |

The two adapters intentionally differ in lifecycle hooks, session mapping, configuration storage, defaults, and host-only capabilities.

## OpenClaw

### Option A — Install from npm

```powershell
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

### Option B — Development install from this repository

Run both commands from the repository root. Preparation builds the shared core into the OpenClaw package but does not install or restart the plugin.

```powershell
pnpm prepare:openclaw
openclaw plugins install .\packages\openclaw
openclaw gateway restart
```

This installs a copy under OpenClaw's extensions directory and does not require a `plugins.load` entry. After changing the source or `packages/core`, rerun preparation and reinstall the directory, then restart the gateway.

### Configure

The plugin opens a local configuration page when the gateway starts. It writes `plugins.entries.memos-cloud-openclaw-plugin.config` in `~/.openclaw/openclaw.json`.

Minimal file-based credentials can also be stored in `~/.openclaw/.env`:

```env
MEMOS_API_KEY=mpg-your-key
MEMOS_USER_ID=stable-user-id
```

OpenClaw also supports dynamic multi-agent IDs, per-agent overrides, a direct-session user-ID option, and optional model-based second-pass recall filtering. See the [OpenClaw package guide](packages/openclaw/README.md) for the complete configuration reference.

## DeepSeek Harness

### Install from npm

```powershell
dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

If DSH is not installed globally:

```powershell
npx @deepseek-ai/dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

Restart DSH Web after installing:

```powershell
npx @deepseek-ai/dsh web
```

### Install from this repository

Run these commands from the repository root. Install the workspace dependencies, then create the versioned `.tgz`; packaging does not add the plugin to DSH.

```powershell
pnpm install --frozen-lockfile
pnpm pack:dsh
dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

If DSH is not installed globally:

```powershell
npx @deepseek-ai/dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

The install command derives the tarball filename from `packages/dsh/package.json`, so it remains valid after a version change.

### Configure

Store the API key in `~/.dsh/.credentials.yaml`:

```yaml
MEMOS_API_KEY: mpg-your-key
```

Configure the plugin in `~/.dsh/settings.yaml`:

```yaml
memos-cloud:
  apiKeyEnv: MEMOS_API_KEY
  userId: stable-user-id
  memoryLimitNumber: 6
  includePreference: true
  includeToolMemory: false
  multiAgentMode: false
  relativity: 0.45
```

DSH uses Cordis credential and settings services, captures the completed direct user turn, optionally maps stable Agent presets to `agent_id`, and serializes writes through its adapter queue. See the [DSH package guide](packages/dsh/README.md) for the complete configuration reference.
