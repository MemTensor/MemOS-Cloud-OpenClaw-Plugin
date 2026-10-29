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
配套 SDK 由 DSH 宿主提供，支持的宿主范围见[兼容性](#兼容性)。

### 方式 A — NPM（推荐）

```powershell
dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

未全局安装 DSH 时：

```powershell
npx @deepseek-ai/dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

### 方式 B — 从源码打包

源码构建推荐使用 Node.js 24.9+。安装后的插件运行要求见[兼容性](#兼容性)。

以下命令从 monorepo 仓库根目录执行。先安装 workspace 依赖，再生成带版本号的 `.tgz`；打包过程不会把插件添加到 DSH。开发 SDK 版本与 lockfile 固定一套经过验证的构建基线，安装后的插件使用实际宿主提供的 SDK。

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

在启用了凭据存储的 Profile（如新版 Web、SDK、ACP）中，也可以将 API Key 放在 **`~/.dsh/.credentials.yaml`** 的 `refs` 下。请添加到现有映射中，保留其他凭据和 `records`：

```yaml
version: 1
refs:
  MEMOS_API_KEY: mpg-your-key
records: {}
```

在 macOS 和 Linux 上，将该凭据文件权限限制为 `0600`；新版宿主会拒绝其他用户可读取的文件。

新版默认 headless 禁用凭据存储，应通过启动环境或 `.env` 提供 Key；需要使用已保存凭据时，显式恢复宿主的凭据存储配置。宿主升级可能改变凭据顺序，详见 [DSH 凭据升级说明](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/upgrade-guide/v0.2.1-alpha.2/stored-credentials-precedence/guide.zh.md)。

User ID 可以通过 `.env` 中的 `MEMOS_USER_ID` 配置，也可以通过下方介绍的 Settings / Profile 配置（早期宿主使用 `settings.yaml`）中的 `userId` 配置。

### 2. 插件参数

支持 Settings 表单的宿主：在 Settings 中编辑 `memos-cloud`，配置保存在当前 profile 的 `cordis.patch.yml` 中。例如：

```yaml
- id: memos-cloud
  config:
    apiKeyEnv: MEMOS_API_KEY
    userId: your-stable-user-id
```

早期 DSH 仍使用 **`~/.dsh/settings.yaml`**：

**最小配置**

```yaml
memos-cloud:
  apiKeyEnv: MEMOS_API_KEY
```

推荐按上文将 API Key 和 User ID 放在 `.env` 中；普通参数在 Settings 或对应版本的配置文件中编辑。

升级到支持 Settings 表单的宿主时，插件会迁移 `settings.yaml` 的 `memos-cloud` 段，也可从 `settings.yaml.imported` 恢复。当前 Profile 的显式配置优先，其他插件的配置与注释保留。

移除全局旧配置前，插件先在 `DSH_HOME`（默认 `~/.dsh`）保存共享的 `memos-cloud.legacy.json`，供其他 Profile 继续迁移。每个迁移中的 Profile 另存自己的备份，成功后记录 `memos-cloud.migration.json`。单个 Profile 完成后仍保留共享备份；该 Profile 的完成标记可防止重启或 Settings 重置后再次导入同一份旧配置。

如果全局旧配置和共享备份均已移走，插件可从 `DSH_HOME/profiles` 下保留的备份恢复。从其他 Profile 恢复时，备份内容不一致会暂停迁移。迁移失败时跳过本插件的记忆请求，修正配置后重启重试。备份在 POSIX 系统上的权限为 `0600`，可能包含旧 API Key，应按凭据文件保管。

**配置优先级**

| 配置项与场景 | 优先级（从高到低） |
| --- | --- |
| API Key：新版宿主启用凭据存储 | 显式 `apiKey` → `.credentials.yaml` 中的同名 `refs` → 启动进程环境变量 → 启动目录 `.env` → `DSH_HOME/.env` |
| API Key：新版默认 headless，未启用凭据存储 | 显式 `apiKey` → 启动进程环境变量 → 启动目录 `.env` → `DSH_HOME/.env` |
| User ID | 显式 `userId` → 启动环境中的 `MEMOS_USER_ID`（进程环境 → 启动目录 `.env` → `DSH_HOME/.env`）→ `deepseek-harness-user` |
| 其他普通参数 | Settings / Profile 显式配置（早期宿主为 `settings.yaml`）→ 插件默认值 |

`apiKeyEnv` 填写凭据名称（默认 `MEMOS_API_KEY`），同时用于凭据引用和同名环境变量查找；`.credentials.yaml` 不提供 User ID 或其他普通参数。插件先调用宿主的 `credentials.resolve()`，未解析到非空 Key 时才回退到启动环境。旧版宿主的凭据提供方可能仍将环境变量排在存储之前，插件沿用其规则。新版存储中已有同名 Key 时，单独修改环境变量不会覆盖它，应更新或移除已保存的引用。

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

启用 `multiAgentMode` 后，search 与 add 都使用会话的当前预设作为 `agent_id`，切换预设时也会切换记忆分区。优先调用宿主的 `agentPresets.presetForSession(session)`；该服务或方法不可用时，再尝试读取 `sessionProjections.stateOf(session, 'agentPreset')`。两种读取接口均不可用、旧投影未注册或所选接口抛错时，回退到保存初始预设的 `session.header.agentPreset`。新版接口明确返回 `null` 或旧投影明确表示已清空时，不再恢复旧投影或头部值。headless 等 DSH 部署可能创建没有 preset 的 Session；此时使用显式配置的 `agentId`，没有回退值则不传 `agent_id`。加入父 Agent preset 的 subagent 与父 Agent 共享 preset 级记忆分区，但仍使用各自独立的 `conversation_id`。

由于 preset 会按 Session 选择 `agent_id`，启用 `multiAgentMode` 时不要再在 `filter` 中设置固定 `agent_id`；配置校验会拒绝这种冲突组合。

## 兼容性

- 支持的宿主系列：`0.1.x`（最低 `0.1.0-rc.6`）与 `0.2.x`，`engines.dsh` 为 `>=0.1.0-rc.6 <0.3.0-0`
- 完整 DSH CLI 安装：`0.1.7-rc.2`、`0.2.1-rc.2`、`0.2.1-rc.4`
- workspace 构建与开发 SDK 基线：`0.2.1-rc.2`；旧版 SDK 行为与类型检查还覆盖 `0.1.0-rc.6` 和 `0.1.7-rc.2`
- Profile 包管理器：pnpm `11.9.0`、`12.11.2`
- 插件的 Node.js 声明：`^22.19.0 || >=24.0.0`，保留旧宿主的 Node 22 支持；实际运行还必须满足宿主要求
- 采用 [DSH Node 24 升级规范](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/upgrade-guide/v0.2.1-rc.2/node-24/guide.zh.md)的新版宿主要求 Node.js ≥24.9.0；CI 对旧宿主使用 Node 22.19+（22.x），对 workspace 基线与 `0.2.x` 宿主使用 Node 24.9+（24.x）
- MemOS Cloud API：`/api/openmem/v1`

维护规则：同一插件发行版支持两个宿主系列，每次发布都回归旧宿主、新宿主与跨系列升级。宿主系列内升级不需要逐个加入白名单；引入新的 SDK API 时保留旧宿主适配或能力检测。未来取消 `0.1.x` 支持或增加 `0.3.x` 支持，必须通过新的插件版本、兼容声明和迁移说明交付，不能静默改变已有包。支持范围是维护承诺，上述具体版本是实际回归样本，并不表示已测试所有未来宿主版本。

## 安全和隐私

- Recall JSON 会转义 `<`，并明确标记为不可信、只读背景信息。
- 插件不会执行记忆中的指令、权限声明或工具请求。
- 永不上传 cwd、完整配置、system prompt、reasoning、插件注入上下文或附件二进制；仅在启用 `includeToolMemory` 时上传工具参数和文本结果。非文本结果使用省略标记；参数超出预算时整组省略关联的工具调用和结果，不生成无效 JSON。
- 保留 DSH 原消息 ID 和事件时间。
- 只有显式启用 `allowPublic` 时才允许公开写入。
- Warning 不包含 API key、Authorization header 或请求 body。

## 安装与升级规范

`engines.dsh` 声明支持的宿主系列；支持此字段的 DSH 优先按它判定，旧宿主回退到 DSH SDK peers。SDK peers 覆盖 `0.1.x` 与 `0.2.x` 正式版，并为已知的 RC 基线声明预发布范围，以匹配 npm/pnpm 的标准 semver 规则。DSH 的宿主检查会启用 `includePrerelease`；包管理器默认只接纳范围中相同版本基线的预发布版本，因此不能将两种检查混为一谈。

| 场景 | 操作与预期 |
| --- | --- |
| DSH `0.1.x` 安装最新版插件 | 在原宿主中执行 `dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest`，安装、启动和记忆功能均可用 |
| DSH `0.2.x` 安装最新版插件 | 使用同一份插件包，无需补装 SDK 或豁免兼容检查 |
| 最新版插件已装在 `0.1.x`，宿主升到 `0.2.x` | 保留 `DSH_HOME` 与同一 Profile，升级完整 DSH 发行包后重启；插件无需重新安装 |
| 旧版插件与 `0.1.x` 一起升级 | 推荐先在旧宿主中把插件升级到最新版，验证后再升级宿主 |
| 已先升级宿主，旧插件被拒绝启动 | 使用新宿主的 `dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest` 原地更新，再启动；CLI 更新不要求先成功启动旧插件 |

原地更新使用与首次安装相同的 `add` 命令；无需先 `remove`。保留原 `DSH_HOME`（默认 `~/.dsh`）、Profile 名称、`.env` 和 `cordis.patch.yml`，尤其是 `userId` 与 `agentId`，以继续使用原记忆分区。升级前保留该目录和旧插件包的备份，便于回退；不要用 `--from-default-profile` 重建已有 Profile。

以源码包为例，先按方式 B 完成打包，再从仓库根目录在当前 `0.1.x` 宿主上执行：

```powershell
dsh plugin --profile web add ".\packages\dsh\artifacts\memtensor-memos-cloud-dsh-plugin-$(node -p "require('./packages/dsh/package.json').version").tgz"
```

重启旧宿主验证后，升级完整的 DSH 安装，再用同一个 `DSH_HOME` 启动 `dsh web`。已先升级宿主时，也可直接用同一条 `add` 命令更新插件。旧插件是否支持新宿主由旧包自身声明决定；新版插件无法回写历史包的兼容声明，也不要求宿主拒绝所有旧包。

通过 `dsh plugin add` 将插件启用到 Profile。也支持在空项目中用 npm 或 pnpm 安装包并在 Node.js 中导入插件定义：宿主 SDK 声明为可选 peer，仅在插件运行时加载。独立导入不会启用记忆功能，执行插件仍需要完整 DSH 宿主提供同一组 SDK。不要单独补装 `dsh-scope` 等 SDK，也不要用兼容豁免绕过更新。

## 退出行为与回归

回写在 `turn/end` 入队，并在宿主等待的 `session/flush` 检查点完成当前会话的队列，防止 headless 在回写完成前退出。等待预算至少 15 秒，并按入队时的实际回写超时、重试次数和同会话排队情况计算；其他会话可并行运行。Settings 修改模式或超时仅影响之后入队的请求。销毁时停止新任务、取消召回并等待回写，超时明确告警。信号退出仍受 DSH 自身 5 秒销毁上限约束，强制终止无法保证回写完成。`asyncMode: true` 表示等待服务端接受请求，记忆可检索的时间取决于云端处理。

行为测试：`pnpm --filter @memtensor/memos-cloud-dsh-plugin test`。设置 `DSH_TEST_RUNTIME` 指向隔离宿主安装目录，可对另一套 SDK 运行同一行为测试与 `pnpm --filter @memtensor/memos-cloud-dsh-plugin test:types`。

已有 tgz 时，设置 `DSH_TEST_PACKAGE` 为其绝对路径，运行 `pnpm --filter @memtensor/memos-cloud-dsh-plugin test:standalone`，无需宿主即可检查 npm/pnpm 安装和 Node.js 导入。检查真实 CLI 安装、共享宿主 SDK 解析、Settings、迁移、召回、工具采集和退出回写时，还需设置 `DSH_TEST_RUNTIME` 为包含 `node_modules/@deepseek-ai/dsh` 的完整宿主安装目录，再运行 `pnpm --filter @memtensor/memos-cloud-dsh-plugin test:host`。该 smoke 的 HTTP 接口使用本地测试服务。

如需打包并执行以上两种检查，按上文设置 `DSH_TEST_RUNTIME` 后，从仓库根目录运行 `pnpm exec node scripts/verify-package-artifacts.mjs --plugin dsh`。

通过 `DSH_TEST_PNPM` 指定待验证的包管理器可执行文件，通过 `DSH_TEST_PNPM_VERSION` 指定期望版本。Smoke 会同时检查可执行文件版本和实际 Profile 安装输出，避免被 workspace 的构建 pnpm 版本替代。设置 `DSH_TEST_UPGRADE_FROM` 为旧版完整 DSH 安装目录，可验证最新版插件跨宿主复用、先升级插件再升级宿主、以及先升级宿主再原地更新插件，均检查 Settings 保留与实际安装版本。旧插件默认由同一份代码生成不同版本、仅支持 `0.1.x` 的测试包，用于验证安装替换和配置保留。设置 `DSH_TEST_UPGRADE_PACKAGE` 为历史发布包时，先安装旧包并保存 Profile 配置，再验证实际更新、配置保留和更新后的行为；不会要求旧包具备新版 Settings 表单或退出能力，也不会认证旧包的运行行为。CI 覆盖两种 pnpm 版本，并验证 `0.1.7-rc.2` 到 `0.2.1-rc.4` 的升级。

真实环境回归：`node packages/dsh/scripts/live-regression.mjs /absolute/config.json all`。配置文件指定 `root`、`runtimes.old` / `runtimes.target`、`plugin` 安装包、`modelURL` / `model` / `modelKeyEnv`、`memoryURL`，以及包含现有凭据的 `envFiles` 路径。脚本创建隔离 profile 和测试用户，直接访问真实模型与 MemOS，保存脱敏请求、响应、耗时和升级回归结果。
