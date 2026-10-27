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

### 1. 通过 `.env` 配置 API Key 和 User ID（推荐）

在 [MemOS Dashboard](https://memos-dashboard.openmem.net/cn/apikeys/) 创建 API Key。

在 DSH 配置目录创建或编辑 **`~/.dsh/.env`**：

```dotenv
MEMOS_API_KEY=mpg-your-key
MEMOS_USER_ID=your-stable-user-id
```

为每位用户设置稳定且不同的 `MEMOS_USER_ID`，插件会使用同一个 ID 召回和写入该用户的记忆。不配置时默认使用 `deepseek-harness-user`。

DSH 默认读取 `~/.dsh/.env`；执行 `dsh` 命令时所在目录的 `.env` 也会被读取，且优先级更高。

修改 `.env` 后需要重启 DSH，环境变量在启动时读取。

也可以将 API Key 放在 **`~/.dsh/.credentials.yaml`** 的 `refs` 下。请添加到现有映射中，保留其他凭据和 `records`：

```yaml
version: 1
refs:
  MEMOS_API_KEY: mpg-your-key
records: {}
```

User ID 可以通过 `.env` 中的 `MEMOS_USER_ID` 配置，也可以通过下方介绍的 `settings.yaml` 中的 `memos-cloud.userId` 配置。

### 2. 插件参数

DSH `0.1.7-rc.2` / `0.2.1-rc.2`：在 Settings 中编辑 `memos-cloud`，配置保存在当前 profile 的 `cordis.patch.yml` 中。例如：

```yaml
- id: memos-cloud
  config:
    apiKeyEnv: MEMOS_API_KEY
    userId: your-stable-user-id
```

早期 DSH（如 `0.1.0-rc.6`、`0.1.2-rc.1`）仍使用 **`~/.dsh/settings.yaml`**：

**最小配置**

```yaml
memos-cloud:
  apiKeyEnv: MEMOS_API_KEY
```

推荐按上文将 API Key 和 User ID 放在 `.env` 中；普通参数在 Settings 或对应版本的配置文件中编辑。

升级时会自动迁移 `settings.yaml` 的 `memos-cloud` 段，也会恢复之前未成功导入的 `settings.yaml.imported`。当前 profile 的显式配置优先。迁移前在该 profile 中保存权限为 `0600` 的 `memos-cloud.legacy.json`，成功后记录 `memos-cloud.migration.json`，防止重启后恢复已被用户删除的旧值。其他插件的配置与注释保留；迁移失败时暂停召回和回写，修正配置后重启重试。备份可能包含旧 API Key，应按凭据文件保管。

**配置优先级**

同一项支持多个配置来源时，优先级从高到低为：Settings / profile（早期版本为 `settings.yaml`）中直接填写的值 → 启动进程的环境变量 → `~/.dsh/.credentials.yaml` 中的凭据 → 启动目录的 `.env` → `~/.dsh/.env` → 插件默认值。

其中 `.credentials.yaml` 只用于 API Key。`apiKeyEnv` 填写凭据名称（默认 `MEMOS_API_KEY`），实际 Key 放在 `.env` 或 `.credentials.yaml` 中。

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
- `searchTimeoutMs`（可选，默认 `5000`；召回总预算，含重试和凭据读取，`100..5000` ms）
- `syncAddTimeoutMs`（可选，默认 `5000`；仅 `asyncMode: false` 时的单次回写 HTTP 超时，`100..180000` ms）
- `timeoutMs`（兼容旧配置，默认 `5000`，`100..180000` ms；未指定新字段时作为回退值。召回与异步回写取此值和 `5000` 的较小值，同步回写保留原值；新字段优先）
- `searchRetries`（默认：`1`；search 额外重试次数，`0..3`）
- `addRetries`（默认：`0`；add 额外重试次数，`0..3`）
- `allowPublic`（默认：`false`；是否允许生成的记忆进入项目公共记忆库）
- `asyncMode`（默认：`true`；是否让 MemOS 异步处理写入消息）

需要等待云端同步处理时，可配置：

```yaml
searchTimeoutMs: 5000
asyncMode: false
syncAddTimeoutMs: 180000
```

切回 `asyncMode: true` 后，保留的 `syncAddTimeoutMs` 不会延长异步回写；异步回写单次请求仍最多 5 秒。召回失败或预算耗尽后继续正常模型流程，`searchRetries` 的重试也必须在召回总预算内完成。同步回写不会延长召回预算，但会在当前会话正常退出前等待结果确认。现有短 `timeoutMs` 保持原有短超时，旧配置无需改名。

## 工作原理

- **召回**（`agent/pre-step`）：每轮直接用户请求的第一个模型步骤调用 `/search/memory`，并在用户消息前插入召回结果。
- **添加**（`turn/end`）：当前 turn 以 `completed` 结束后，将用户文本、可选的助手文本，以及启用后的关联工具调用/结果发送到 `/add/message`。
- MemOS 请求失败不会中断 Harness turn。默认不处理 subagent；启用 `includeSubagents` 后才会处理。

### 共享的 MemOS API 行为

私有 workspace core 同时供 OpenClaw 适配器使用，因此 DSH 使用相同的 `Authorization: Token` 客户端、请求校验、过滤器构造、超时处理、有界重试、安全序列化、响应校验和 MemOS 工具消息格式。搜索可以通过 `memoryLimitNumber` 请求事实记忆，通过 `includePreference` 与 `preferenceLimitNumber` 请求偏好记忆，并通过 `includeToolMemory` 与 `toolMemoryLimitNumber` 请求工具记忆。响应投影会保持三类结果相互独立，再由 DSH 作为不可信 JSON 上下文插入。

`knowledgebaseIds` 和 `filter` 用于限制 `/search/memory`；配置后，`tags`、`info`、`agentId`、`appId`、`allowKnowledgebaseIds`、`asyncMode` 和 `allowPublic` 会应用到 `/add/message`。`maxQueryChars`、`maxRecallChars`、`maxItemChars` 和 `maxMessageChars` 在文本跨越 MemOS 或宿主边界前限制长度。`searchRetries` 与 `addRetries` 分别配置，因为召回失败与写入失败对宿主的影响不同。

### DSH 适配器边界

共享 core 不包含 DSH 生命周期代码。本插件单独负责 Cordis 凭据/设置服务、`agent/pre-step` 与 `turn/end` 订阅、Session 到 Conversation 的映射、DSH 消息/工具转换、基于 preset 的 agent 归因、消息捕获策略、上下文插入和串行写入队列。共享 MemOS API 层不代表 DSH 自动拥有 OpenClaw 的配置页面、按 Agent 覆盖配置或模型二次召回过滤。

启用 `multiAgentMode` 后，search 与 add 都使用会话 `agentPreset` 投影中的当前预设作为 `agent_id`，切换预设时也会切换记忆分区。投影不可用的运行时回退到 `session.header.agentPreset`，其中保存的是初始预设；明确清空预设时，不再使用旧的头部值。headless 等 DSH 部署可能创建没有 preset 的 Session；此时使用显式配置的 `agentId`，没有回退值则不传 `agent_id`。加入父 Agent preset 的 subagent 与父 Agent 共享 preset 级记忆分区，但仍使用各自独立的 `conversation_id`。

由于 preset 会按 Session 选择 `agent_id`，启用 `multiAgentMode` 时不要再在 `filter` 中设置固定 `agent_id`；配置校验会拒绝这种冲突组合。

## 兼容性

- DeepSeek Harness：已验证 `0.1.2-rc.1` 和 `0.1.0-rc.6`
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

## 兼容与退出行为

DSH peer 范围为 `^0.1.0-rc.6 || ^0.1.2-rc.1 || ^0.2.1-rc.2`。验证覆盖 `0.1.0-rc.6`、`0.1.2-rc.1`、`0.1.7-rc.2` 和 `0.2.1-rc.2`；范围允许的后续版本仍需回归验证。

回写在 `turn/end` 入队，并在宿主等待的 `session/flush` 检查点完成当前会话的队列，防止 headless 在回写完成前退出。等待预算至少 15 秒，并按入队时的实际回写超时、重试次数和同会话排队情况计算；其他会话可并行运行。Settings 修改模式或超时仅影响之后入队的请求。销毁时停止新任务、取消召回并等待回写，超时明确告警。信号退出仍受 DSH 自身 5 秒销毁上限约束，强制终止无法保证回写完成。`asyncMode: true` 表示等待服务端接受请求，记忆可检索的时间取决于云端处理。

行为测试：`pnpm --filter @memtensor/memos-cloud-dsh-plugin test`。设置 `DSH_TEST_RUNTIME` 指向隔离宿主安装目录，可运行同一套测试与 `test:types`；同时设置 `DSH_TEST_PACKAGE` 为打包文件绝对路径后运行 `test:host`，验证真实 CLI 安装、Settings、迁移、召回、工具采集和退出回写（HTTP 使用本地可控服务）。

真实环境回归：`node packages/dsh/scripts/live-regression.mjs /absolute/config.json all`。配置文件指定 `root`、`runtimes.old` / `runtimes.target`、`plugin` 安装包、`modelURL` / `model` / `modelKeyEnv`、`memoryURL`，以及包含现有凭据的 `envFiles` 路径。脚本创建隔离 profile 和测试用户，直接访问真实模型与 MemOS，保存脱敏请求、响应、耗时和升级回归结果。
