# MemOS Cloud 宿主插件

[English](README.md) | [中文](README_ZH.md)

本 pnpm monorepo 统一维护两个拥有独立版本号和宿主适配器的 MemOS Cloud 生命周期插件：

| 宿主 | npm 包 | 详细文档 |
|---|---|---|
| OpenClaw | `@memtensor/memos-cloud-openclaw-plugin` | [`packages/openclaw/README_ZH.md`](packages/openclaw/README_ZH.md) |
| DeepSeek Harness（DSH） | `@memtensor/memos-cloud-dsh-plugin` | [`packages/dsh/README.zh.md`](packages/dsh/README.zh.md) |

用户只需选择与宿主对应的插件，不需要单独安装私有的 `packages/core` workspace；每个公开包都已经包含运行所需的共享 MemOS 核心。

## 共同的 MemOS Cloud 能力

两个插件都使用共享 core 中当前与 OpenClaw 兼容的 MemOS 协议：

- 使用 `Authorization: Token <MEMOS_API_KEY>` 认证；
- 通过 `/search/memory` 召回记忆；
- 通过 `/add/message` 写入消息；
- 投影事实、偏好和工具记忆，并可写入相互关联的工具调用/结果；
- 支持确定性过滤器和知识库范围；
- 支持可选的 `agent_id`、`app_id`、tags、info 和允许写入的知识库；
- 统一进行请求校验、Unicode 安全截断、超时和有界重试；
- MemOS 异常时 fail-open，不中断宿主当前回合。

共同的搜索配置包括：

| 配置 | 作用 |
|---|---|
| `memoryLimitNumber` | 事实记忆最大返回数量 |
| `includePreference` / `preferenceLimitNumber` | 开启并限制偏好记忆召回 |
| `includeToolMemory` / `toolMemoryLimitNumber` | 开启工具调用/结果写入并限制工具记忆召回 |
| `relativity` | 最低语义相关度 |
| `knowledgebaseIds` | 限定可搜索知识库 |
| `recallGlobal` | 不传 `conversation_id` 进行全局搜索 |

两个适配器的生命周期钩子、会话映射、配置存储、默认值和宿主专属能力仍然相互独立。

## OpenClaw

### 方式 A — 从 npm 安装

```powershell
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

### 方式 B — 从本仓库开发安装

以下命令都从仓库根目录执行。准备命令会把共享 core 构建进 OpenClaw 插件，但不会安装插件或重启网关。

```powershell
pnpm prepare:openclaw
openclaw plugins install .\packages\openclaw
openclaw gateway restart
```

该命令会把插件复制到 OpenClaw 扩展目录，不需要配置 `plugins.load`。修改插件源码或 `packages/core` 后，重新执行准备命令并再次安装该目录，再重启 gateway 即可加载新代码。

### 配置

网关启动后，插件会打开本地配置页面，并写入 `~/.openclaw/openclaw.json` 中的 `plugins.entries.memos-cloud-openclaw-plugin.config`。

也可以在 `~/.openclaw/.env` 中保存最小凭据：

```env
MEMOS_API_KEY=mpg-your-key
MEMOS_USER_ID=stable-user-id
```

OpenClaw 还支持动态多 Agent ID、按 Agent 覆盖配置、私聊 Session User ID 和可选的模型二次召回过滤。完整配置请参阅 [OpenClaw 插件文档](packages/openclaw/README_ZH.md)。

## DeepSeek Harness

### 从 npm 安装

```powershell
dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

未全局安装 DSH 时：

```powershell
npx @deepseek-ai/dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

安装后重启 DSH Web：

```powershell
npx @deepseek-ai/dsh web
```

### 从本仓库安装

在仓库根目录执行以下命令。先安装 workspace 依赖，再生成带版本号的 `.tgz`；打包过程不会把插件添加到 DSH。

```powershell
pnpm install --frozen-lockfile
pnpm pack:dsh
dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

### 配置

将 API Key 保存到 `~/.dsh/.credentials.yaml`：

```yaml
MEMOS_API_KEY: mpg-your-key
```

在 `~/.dsh/settings.yaml` 中配置插件：

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

DSH 使用 Cordis 凭据和设置服务，捕获完成的直接用户回合，可选地把稳定的 Agent preset 映射为 `agent_id`，并通过适配器写入队列串行提交。完整配置参考请参阅 [DSH 插件文档](packages/dsh/README.zh.md)。
