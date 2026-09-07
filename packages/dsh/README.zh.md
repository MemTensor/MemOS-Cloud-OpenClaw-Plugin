# MemOS Cloud DeepSeek Harness 插件（Lifecycle）

MemTensor 官方维护。

[English](README.md) | [中文](README.zh.md)

这是一个用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的生命周期 bundle：模型处理当前用户输入前自动从 MemOS Cloud **召回记忆**，本轮成功结束后自动把用户/助手消息 **添加到记忆**。

## 功能

- **召回**：每一轮用户请求的第一个模型步骤之前 → `/search/memory`
- **添加**：该轮以 `completed` 结束后 → `/add/message`
- **确定性过滤**：支持 user、public、knowledgebase、metadata、tags，以及静态或基于 preset 的 agent 隔离
- **生命周期原生**：模型无需决定是否调用记忆工具
- **Fail-open**：MemOS 异常不会中断 Harness 主流程
- **安全采集**：排除 system prompt、reasoning、附件和插件上下文；仅在启用 `includeToolMemory` 时包含工具调用/结果
- 使用 **Token** 认证（`Authorization: Token <MEMOS_API_KEY>`）

## 安装

以下命令将插件安装到 DeepSeek Harness 官网默认的 `web` Profile。

### 方式 A — NPM（推荐）

```powershell
dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

未全局安装 DSH 时：

```powershell
npx @deepseek-ai/dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

### 方式 B — 从源码打包

以下命令从 monorepo 仓库根目录执行。先安装 workspace 依赖，再生成带版本号的 `.tgz`；打包过程不会把插件添加到 DSH。

```powershell
pnpm install --frozen-lockfile
pnpm pack:dsh
dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

未全局安装 DSH 时：

```powershell
npx @deepseek-ai/dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

安装命令会从 `packages/dsh/package.json` 读取版本号，因此版本变化后仍然有效。`lib/` 是构建产物；可安装的包是 `artifacts/` 中的 `.tgz` 文件。

### 移除

```powershell
dsh plugin --profile web remove @memtensor/memos-cloud-dsh-plugin
```

未全局安装 DSH 时：

```powershell
npx @deepseek-ai/dsh plugin --profile web remove @memtensor/memos-cloud-dsh-plugin
```

## 安装或移除后重启 DSH Web

安装或移除插件后，需要重启 DSH Web 以重新加载 `web` Profile。服务已运行时，先在对应终端按 `Ctrl+C` 停止，再重新启动：

```powershell
npx @deepseek-ai/dsh web
```

## 配置

### 1. API Key 凭据

在 [MemOS Dashboard](https://memos-dashboard.openmem.net/cn/apikeys/) 创建 API Key。

DSH 凭据文件：**`~/.dsh/.credentials.yaml`**

写入 API Key：

```yaml
MEMOS_API_KEY: mpg-your-key
```

### 2. 插件参数

DSH 插件配置文件：**`~/.dsh/settings.yaml`**

**最小配置**

```yaml
memos-cloud:
  apiKeyEnv: MEMOS_API_KEY
```

**可选配置**

- `apiKeyEnv`（默认：`MEMOS_API_KEY`；Harness 凭据引用）
- `baseURL`（默认：`https://memos.memtensor.cn/api/openmem/v1`；MemOS API 根地址）
- `userId`（默认：优先读取 `MEMOS_USER_ID`，否则使用 `deepseek-harness-user`；稳定的共享读写用户域）
- `recallEnabled`（默认：`true`；是否在每轮用户请求的第一个模型步骤前搜索）
- `addEnabled`（默认：`true`；是否在当前 turn 以 `completed` 结束后写回）
- `includeAssistant`（默认：`true`；写回时是否包含 assistant 文本）
- `includeSubagents`（默认：`false`；是否处理 `origin: subagent` 的 session）
- `multiAgentMode`（默认：`false`；使用稳定的 DSH `agentPreset` 作为 `agent_id`，没有 preset 时回退到 `agentId`）
- `queryPrefix`（默认：空；每次召回前附加到 query 的文本）
- `recallGlobal`（默认：`false`；不传 `conversation_id`，在用户全部记忆中全局召回）
- `memoryLimitNumber`（默认：`6`；事实记忆返回条数，`1..25`）
- `preferenceLimitNumber`（默认：`6`；偏好记忆返回条数，`1..25`）
- `includePreference`（默认：`true`；是否召回偏好记忆）
- `includeToolMemory`（默认：`false`；是否召回工具记忆并写入相互关联的工具调用/结果）
- `toolMemoryLimitNumber`（默认：`6`；工具记忆返回条数，`1..25`）
- `relativity`（默认：`0.45`；语义相关度阈值，`0..1`）
- `filter`（可选；普通或 per-source 确定性 filter）
- `knowledgebaseIds`（默认：`[]`；搜索知识库 ID；`all` 不能和具体 ID 混用）
- `tags`（默认：`[deepseek-harness]`；添加记忆时使用的 tags）
- `info`（默认：`{}`；非空字符串 metadata）
- `agentId`（可选；添加 `agent_id`，并限制 user 搜索分支）
- `appId`（可选；添加 `app_id`；不会自动成为搜索 filter）
- `allowKnowledgebaseIds`（默认：`[]`；允许写入的知识库 ID）
- `maxQueryChars`（默认：`4000`；搜索 query 字符预算）
- `maxRecallChars`（默认：`12000`；召回文本总字符预算）
- `maxItemChars`（默认：`2000`；单条召回记忆字符预算）
- `maxMessageChars`（默认：`12000`；单条写回消息字符预算）
- `timeoutMs`（默认：`5000`；HTTP 超时，`100..60000` ms）
- `searchRetries`（默认：`1`；search 额外重试次数，`0..3`）
- `addRetries`（默认：`0`；add 额外重试次数，`0..3`）
- `allowPublic`（默认：`false`；是否允许生成的记忆进入项目公共记忆库）
- `asyncMode`（默认：`true`；是否让 MemOS 异步处理写入消息）

## 工作原理

- **召回**（`agent/pre-step`）：每轮直接用户请求的第一个模型步骤调用 `/search/memory`，并在用户消息前插入召回结果。
- **添加**（`turn/end`）：当前 turn 以 `completed` 结束后，将用户文本、可选的助手文本，以及启用后的关联工具调用/结果发送到 `/add/message`。
- MemOS 请求失败不会中断 Harness turn。默认不处理 subagent；启用 `includeSubagents` 后才会处理。

### 共享的 MemOS API 行为

私有 workspace core 同时供 OpenClaw 适配器使用，因此 DSH 使用相同的 `Authorization: Token` 客户端、请求校验、过滤器构造、超时处理、有界重试、安全序列化、响应校验和 MemOS 工具消息格式。搜索可以通过 `memoryLimitNumber` 请求事实记忆，通过 `includePreference` 与 `preferenceLimitNumber` 请求偏好记忆，并通过 `includeToolMemory` 与 `toolMemoryLimitNumber` 请求工具记忆。响应投影会保持三类结果相互独立，再由 DSH 作为不可信 JSON 上下文插入。

`knowledgebaseIds` 和 `filter` 用于限制 `/search/memory`；配置后，`tags`、`info`、`agentId`、`appId`、`allowKnowledgebaseIds`、`asyncMode` 和 `allowPublic` 会应用到 `/add/message`。`maxQueryChars`、`maxRecallChars`、`maxItemChars` 和 `maxMessageChars` 在文本跨越 MemOS 或宿主边界前限制长度。`searchRetries` 与 `addRetries` 分别配置，因为召回失败与写入失败对宿主的影响不同。

### DSH 适配器边界

共享 core 不包含 DSH 生命周期代码。本插件单独负责 Cordis 凭据/设置服务、`agent/pre-step` 与 `turn/end` 订阅、Session 到 Conversation 的映射、DSH 消息/工具转换、基于 preset 的 agent 归因、消息捕获策略、上下文插入和串行写入队列。共享 MemOS API 层不代表 DSH 自动拥有 OpenClaw 的配置页面、按 Agent 覆盖配置或模型二次召回过滤。

启用 `multiAgentMode` 后，search 与 add 都使用 `session.header.agentPreset` 作为 `agent_id`。headless 等 DSH 部署可能创建没有 preset 的 Session；此时使用显式配置的 `agentId`，没有回退值则不传 `agent_id`。加入父 Agent preset 的 subagent 与父 Agent 共享 preset 级记忆分区，但仍使用各自独立的 `conversation_id`。

由于 preset 会按 Session 选择 `agent_id`，启用 `multiAgentMode` 时不要再在 `filter` 中设置固定 `agent_id`；配置校验会拒绝这种冲突组合。

## 兼容性

- DeepSeek Harness：`0.1.0-rc.6`
- Node.js：`^22.19.0 || >=24.0.0`
- MemOS Cloud API：`/api/openmem/v1`

Harness 当前仍是 developer preview；升级后应重新运行全部测试和真实 smoke。

## 安全和隐私

- Recall JSON 会转义 `<`，并明确标记为不可信、只读背景信息。
- 插件不会执行记忆中的指令、权限声明或工具请求。
- 永不上传 cwd、完整配置、system prompt、reasoning、插件注入上下文或附件二进制；仅在启用 `includeToolMemory` 时上传工具参数和文本结果。非文本结果使用省略标记；参数超出预算时整组省略关联的工具调用和结果，不生成无效 JSON。
- 保留 DSH 原消息 ID 和事件时间。
- 只有显式启用 `allowPublic` 时才允许公开写入。
- Warning 不包含 API key、Authorization header 或请求 body。
