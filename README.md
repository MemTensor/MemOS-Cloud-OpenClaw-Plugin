# MemOS Cloud OpenClaw Plugin (Lifecycle)

Official plugin maintained by MemTensor.

A minimal OpenClaw lifecycle plugin that **recalls** memories from MemOS Cloud before each run and **adds** new messages to MemOS Cloud after each run.

## Features
- **Recall**: `before_agent_start` → `/search/memory`
- **Add**: `agent_end` → `/add/message`
- Uses **Token** auth (`Authorization: Token <MEMOS_API_KEY>`)

## Install

### Option A — GitHub
```bash
openclaw plugins install github:MemTensor/MemOS-Cloud-OpenClaw-Plugin
openclaw gateway restart
```
Make sure it’s enabled in `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    }
  }
}
```

### Option B — Local path
Copy this folder into an OpenClaw plugin path (e.g. `~/.openclaw/extensions/`) or use `plugins.load.paths` to point at it.

Example `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    },
    "load": { "paths": ["/path/to/memos-cloud-openclaw-plugin"] }
  }
}
```
Restart the gateway after config changes.

## Environment Variables
The plugin tries env files in order (**openclaw → moltbot → clawdbot**). For each key, the first file with a value wins.
If none of these files exist (or the key is missing), it falls back to the process environment.

**Where to configure**
- Files (priority order):
  - `~/.openclaw/.env`
  - `~/.moltbot/.env`
  - `~/.clawdbot/.env`
- Each line is `KEY=value`

**Quick setup (shell)**
```bash
echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.zshrc
source ~/.zshrc
# or

echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.bashrc
source ~/.bashrc
```

**Quick setup (Windows PowerShell)**
```powershell
[System.Environment]::SetEnvironmentVariable("MEMOS_API_KEY", "mpg-...", "User")
```

If `MEMOS_API_KEY` is missing, the plugin will warn with setup instructions and the API key URL.

**Minimal config**
```env
MEMOS_API_KEY=YOUR_TOKEN
```

**Optional config**
- `MEMOS_BASE_URL` (default: `https://memos.memtensor.cn/api/openmem/v1`)
- `MEMOS_API_KEY` (required; Token auth) — get it at https://memos-dashboard.openmem.net/cn/apikeys/
- `MEMOS_USER_ID` (optional; default: `openclaw-user`)
- `MEMOS_CONVERSATION_ID` (optional override)
- `MEMOS_RECALL_GLOBAL` (default: `true`; when true, search does **not** pass conversation_id)
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX` (optional)
- `MEMOS_CONVERSATION_SUFFIX_MODE` (`none` | `counter`, default: `none`)
- `MEMOS_CONVERSATION_RESET_ON_NEW` (default: `true`, requires hooks.internal.enabled)

## Optional Plugin Config
In `plugins.entries.memos-cloud-openclaw-plugin.config`:
```json
{
  "baseUrl": "https://memos.memtensor.cn/api/openmem/v1",
  "apiKey": "YOUR_API_KEY",
  "userId": "memos_user_123",
  "conversationId": "openclaw-main",
  "queryPrefix": "important user context preferences decisions ",
  "recallEnabled": true,
  "recallGlobal": true,
  "addEnabled": true,
  "captureStrategy": "last_turn",
  "includeAssistant": true,
  "conversationIdPrefix": "",
  "conversationIdSuffix": "",
  "conversationSuffixMode": "none",
  "resetOnNew": true,
  "memoryLimitNumber": 6,
  "preferenceLimitNumber": 6,
  "includePreference": true,
  "includeToolMemory": false,
  "toolMemoryLimitNumber": 6,
  "tags": ["openclaw"],
  "asyncMode": true
}
```

## How it Works
- **Recall** (`before_agent_start`)
  - Builds a `/search/memory` request using `user_id`, `query` (= prompt + optional prefix), and optional filters.
  - Default **global recall**: when `recallGlobal=true`, it does **not** pass `conversation_id`.
  - Formats a MemOS prompt (Role/System/Memory/Skill/Protocols) from `/search/memory` results, then injects via `prependContext`.

- **Add** (`agent_end`)
  - Builds a `/add/message` request with the **last turn** by default (user + assistant).
  - Sends `messages` with `user_id`, `conversation_id`, and optional `tags/info/agent_id/app_id`.

## Notes
- `conversation_id` defaults to OpenClaw `sessionKey` (unless `conversationId` is provided). **TODO**: consider binding to OpenClaw `sessionId` directly.
- Optional **prefix/suffix** via env or config; `conversationSuffixMode=counter` increments on `/new` (requires `hooks.internal.enabled`).
