# DeepSeek Harness 后端设计规格

> 状态：设计评审
> 日期：2026-08-20
> 目标版本：DeepSeek Harness `0.1.0-rc.8`
> 后端标识：`dsh-sdk`

## 1. 决策摘要

feishu-codex-bridge 将以一个独立的 `AgentBackend` 接入 DeepSeek Harness（下文简称 DSH），通过 DSH 官方 SDK JSON-RPC Server 的 stdio 协议运行，不复用 Codex 或 Claude 的适配层。

首个版本采用以下边界：

- DSH 是实验性可选后端，不改变现有默认后端。
- 每个飞书话题对应一个稳定的 DSH `sessionId`，每个活跃话题拥有独立子进程。
- 会话历史由 DSH JSONL 持久化；Bridge 重启或子进程被中止后，使用同一 `sessionId` 恢复。
- 仅支持 `full` 权限模式。Bridge 不声称 DSH 已提供与现有 `qa` / `write` 模式等价的隔离。
- 强制使用 DSH native tools，禁用 Code/PTC 工具模式。
- 运行依赖按需安装到 Bridge 私有后端目录，并精确锁定 `0.1.0-rc.8`。
- 首个版本不实现 DSH Web、ACP、历史会话选择器、运行中 steer、交互审批或图片输入。

## 2. 背景与目标

### 2.1 目标

1. 用户可以在后端选择器中安装并选择 `DeepSeek Harness`。
2. 文本消息可以在飞书话题内得到流式回答，并展示推理、工具调用和用量信息。
3. 同一话题的后续消息延续同一 DSH 会话。
4. Bridge 重启、DSH 子进程退出或用户中止当前轮次后，下一条消息仍能恢复该话题的历史。
5. DSH 的安装、检测、诊断和卸载遵循现有后端管理流程。
6. 权限和安全限制在 UI、诊断信息和文档中保持一致，不给出超出实际能力的保证。

### 2.2 非目标

- 不把 DSH 设为默认后端。
- 不修改 Codex App Server 或 Claude Agent SDK 的行为。
- 不接入 DSH Web Server，也不开放本地 HTTP 端口。
- 不使用 DSH ACP 作为 Bridge 会话协议。
- 不复制、迁移或读取用户的 DSH 凭据；认证由 DSH 官方 credentials provider 从继承环境或 `$DSH_HOME/.credentials.yaml` 解析。
- 不为 DSH 模拟 `qa` / `write` 权限模式。
- 不在首个版本实现历史会话列表、fork、compact、goal、steer、交互审批或图片输入。
- 不解析或修改 DSH 自己的 JSONL 历史文件。

## 3. 上游能力核验

本设计基于 DSH 官方 `dsh-v0.1.0-rc.8` 标签，而非浮动的 npm `latest` 标签：

- [DeepSeek Harness rc.8 源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8)
- [Headless CLI](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8/examples/headless-agent)
- [ACP Agent](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8/examples/acp-agent)
- [SDK JSON-RPC Protocol](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8/packages/sdk/protocol)
- [SDK JSON-RPC Server](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8/packages/sdk/server)
- [JSON-RPC Agent Example](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8/examples/jsonrpc-agent)
- [DeepSeek LLM Adapter](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8/packages/llm/llm-deepseek)
- [Session Persistence](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8/packages/session/session-persistence)

### 3.1 协议选择

| 方案 | 结论 | 原因 |
|---|---|---|
| Headless CLI | 不采用 | 一次命令创建一次任务，只输出最终答案，不能承载 Bridge 的多轮流式会话 |
| ACP | 不采用 | rc.8 仅支持新会话；不支持 load、list、resume、delete 或 fork，Bridge 重启后无法可靠续接 |
| Web API | 不采用 | 引入额外 Web 运行时和未认证本地端口，协议面过大且不是 Bridge 所需的最小集成面 |
| SDK JSON-RPC stdio | 采用 | 官方协议提供稳定 `sessionId`、流式事件和 JSONL 持久化，且无需开放网络端口 |

SDK JSON-RPC 的最小方法集合为：

- `initialize`：建立进程级运行配置。
- `session/prompt`：向一个稳定 `sessionId` 提交一轮输入。
- `shutdown`：优雅关闭进程。
- `session.event`：流式会话事件通知。
- `session.status`：会话状态通知。

协议当前没有逐轮 cancel 或逐会话 close。Bridge 的中止语义因此是终止该话题的 DSH 子进程；下一条消息再以相同 `sessionId` 从 JSONL 历史恢复。

## 4. 总体架构

```text
Feishu message
      |
      v
session orchestrator
      |
      v
AgentBackend registry ---- backend catalog / installer
      |
      v
DshBackend (one runtime per active Feishu thread)
      |
      +-- JSON-RPC client over stdin/stdout
      +-- stderr capture and lifecycle watchdog
      |
      v
dsh-jsonrpc-agent
      |
      +-- generated Bridge profile
      +-- DeepSeek LLM adapter
      +-- native tools and sandbox
      +-- JSONL persistence under the bot state directory
```

### 4.1 模块职责

`DshBackend` 负责：

- 子进程创建、握手、关闭和异常回收。
- JSON-RPC 请求、响应和通知关联。
- DSH 事件到 Bridge `AgentEvent` 的转换。
- 稳定会话 ID、路由配置和进程状态管理。
- 中止后可恢复的生命周期语义。

现有 session orchestrator 继续负责：

- 飞书话题与 Bridge session 的绑定。
- 流式卡片渲染、并发限制、超时和用户可见错误。
- model、effort、mode 等路由设置的持久化。

安装器负责：

- 精确安装 DSH 运行包集合。
- 校验主包版本和 `dsh-jsonrpc-agent` 可执行文件。
- 失败时回滚本次安装集合。

## 5. 后端目录与安装

### 5.1 Catalog 定义

Catalog 新增以下记录：

```ts
{
  id: 'dsh-sdk',
  agentFamily: 'dsh',
  access: 'jsonrpc',
  displayName: 'DeepSeek Harness',
  supportedModes: ['full'],
  blurb: '实验性 DSH JSON-RPC 后端（仅 full）'
}
```

`BackendAccess` 增加 `jsonrpc`，避免把 stdio JSON-RPC 误标为 ACP 或某一种语言 SDK。

### 5.2 精确依赖集合

DSH 仍处于 developer preview，npm 的 `latest` 与预发布标签可能不同步，因此安装器必须使用精确版本：

```text
@deepseek-ai/dsh@0.1.0-rc.8
@deepseek-ai/dsh-sdk-jsonrpc-demo@0.1.0-rc.8
@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.0-rc.8
@deepseek-ai/dsh-agent-spine-demo@0.1.0-rc.8
```

实现前的安装探针必须在空目录中验证这组包能够解析生成配置所引用的全部插件。若 npm 包依赖闭包已包含其中某个包，可以减少显式安装项，但所有直接使用的包仍须保持同一精确版本，且不得改用浮动 tag。

### 5.3 安装器扩展

`BackendDep` 增加可选的 `installSpecs: readonly string[]`：

- 未设置时，沿用现有单包 `pkg@version` 行为。
- 设置时，一次 npm 操作安装整个精确包集合。
- `pkg` 仍是版本检测和卸载身份的主包。
- `binName` 仍用于验证私有 `.bin` 中的入口。
- 安装失败时，回滚本次声明的全部包，不留下部分可用状态。
- 卸载时，移除声明集合中的全部直接依赖。
- 检查更新仍以 `pkg` 为主包，预发布版本不自动升级。

这是一项向后兼容的通用能力，Codex 和 Claude 的现有单包定义无需修改。

## 6. 运行配置与数据隔离

### 6.1 Bridge 生成的 DSH profile

Bridge 在私有后端目录生成版本化 profile。profile 只组合 DSH 官方插件，不包含用户密钥：

- SDK JSON-RPC server
- official local credentials provider
- DeepSeek LLM adapter
- agent spine
- local subprocess
- sandbox policy、sandboxed bash 与 sandboxed filesystem
- user approval policy，固定为 `never`
- filesystem observation policy 与 native filesystem tools
- JSONL persistence
- checkpoint policy
- context compaction
- native tools

profile 位于后端依赖目录旁，使 DSH Loader 可以从同一 `node_modules` 解析裸包名。profile 内容由 Bridge 管理，用户升级 DSH 版本时可按模板版本重建。agent spine 的 `workspaceContext` 和 skills 在首版关闭，避免未请求的工作区预扫描和能力扩张；文件只在模型明确调用 native tools 时读取。

### 6.2 进程环境

每个子进程继承正常用户环境，并由 Bridge 补充：

```text
DSH_CORDIS_CONFIG=<generated profile path>
DSH_CWD=<project cwd>
DSH_SESSION_ROOT=<per-bot DSH state directory>
DSH_PERMISSION_MODE=danger-full-access
DSH_TOOLS_MODE=native
DSH_TELEMETRY_DISABLED=1
FEISHU_CODEX_BRIDGE_DSH_EFFORT=<off|low|high|max>
FEISHU_CODEX_BRIDGE=1
```

约束如下：

- `DEEPSEEK_API_KEY` 由 DSH 官方 credentials provider 按其既有优先级解析，包括继承环境和 `$DSH_HOME/.credentials.yaml`；Bridge 不打开、不复制、不打印、不持久化该值。
- `DSH_SESSION_ROOT` 按机器人实例隔离，避免多个飞书机器人意外共享历史。
- 项目 `cwd` 在 session 创建时固化，并在恢复时再次校验。
- `FEISHU_CODEX_BRIDGE_DSH_EFFORT` 是 Bridge 私有变量，由生成的 profile 映射到 DeepSeek adapter 的 `reasoningEffort`；它不是上游 JSON-RPC 字段。
- stdout 只承载 JSON-RPC；stderr 单独捕获并做长度限制，避免协议污染和无限日志增长。

## 7. 会话生命周期

### 7.1 新建会话

1. Bridge 为飞书话题生成随机 UUID，并将其保存为 DSH `sessionId`。
2. 创建该话题专属的 `dsh-jsonrpc-agent` 子进程。
3. 发送 `initialize`，配置 provider、model 和 cwd；effort 已在进程启动时由 profile 配置。
4. 发送第一次 `session/prompt`。
5. 收集通知并映射为 Bridge 流式事件。
6. 轮次完成后保留健康子进程，供该话题下一轮复用。

### 7.2 恢复会话

Bridge 重启后不需要保留 DSH 进程：

1. 从 Bridge session store 读取原 `sessionId`、cwd 和路由配置。
2. 以同一 `DSH_SESSION_ROOT` 启动新子进程并完成 `initialize`。
3. 向原 `sessionId` 发送下一次 `session/prompt`。
4. DSH 根据 JSONL 持久化记录恢复上下文并继续运行。

Bridge 不读取或重写 JSONL。恢复是否成功以 DSH 协议响应和后续事件为准。

若上一个进程在 turn 中途退出，DSH persistence 的 cold-load 恢复会保留已经落盘的事实，并以合成的 `turn/end { interrupted }` 配平未完成轮次，再接受新 prompt。Bridge 不尝试续跑被中断工具，也不自动重放用户消息，从而避免重复副作用。

### 7.3 模型或 effort 变更

DSH rc.8 的初始化配置是进程级配置。话题设置在两轮之间发生变化时：

1. 等待当前轮结束。
2. 向旧进程发送 `shutdown`，超时则终止进程组。
3. 使用新 model / effort 启动进程。
4. 保持原 `sessionId` 和 `DSH_SESSION_ROOT`，下一轮从既有历史恢复。

运行中的设置变更只影响下一轮，不改变当前轮。

### 7.4 中止与关闭

- `abort`：终止整个子进程组，立即把运行标记为中止；不删除 session 数据。
- `close`：先发送 `shutdown`，在有界等待后终止残留进程组。
- `isAlive`：以子进程退出状态和 JSON-RPC transport 状态共同判断。
- 异常退出：当前轮返回结构化错误，thread runtime 标记为 dead；下一条消息可惰性恢复。

## 8. JSON-RPC 与事件映射

### 8.1 传输约束

- stdin / stdout 使用逐行 JSON-RPC 2.0。
- 每个请求使用单调递增 id，并以 pending map 关联响应。
- stdout 的非 JSON 行视为协议错误，不进入用户回答。
- `session/prompt` 发出前即注册通知监听和轮次状态，避免丢失早到事件。
- 同一 session 只允许一个 active prompt；后端把 prompt 后收到的第一个 `turn/start` 记录为本轮 turn number。
- 一轮完成条件为该 turn 的 `turn/end`，并随后观察到 session idle；RPC 错误或进程退出也会结束等待。

### 8.2 DSH 到 Bridge 的事件映射

| DSH 事件 | Bridge 事件 | 处理 |
|---|---|---|
| `turn/start` | run started | 建立当前 turn 状态 |
| `assistant/chunk` / `text-delta` | text delta | 追加可见回答 |
| `assistant/chunk` / `reasoning-delta` | reasoning delta | 追加推理区域 |
| `assistant/chunk` / `usage` | usage | 按 step 汇总 input / output tokens |
| `tool/call` | tool started | 显示工具名和安全裁剪后的输入 |
| `tool/result` | tool completed | 显示状态和安全裁剪后的结果 |
| `assistant/message` | message reconciliation | 补齐缺失文本和用量，禁止重复发送已经流式输出的内容 |
| `turn/end` | done/error | 根据 reason 完成本轮，不从此事件虚构用量 |
| `session.status=idle` | transport settled | 允许释放本轮监听器 |
| `subagent.started/finished` | tool/status metadata | 作为辅助状态，不伪装成独立回答 |

事件归一化层必须按 `sessionId` 过滤通知。未知事件记录为受限 debug 日志，不使当前轮失败，以兼容后续 rc 增加事件类型。

### 8.3 错误映射

| 情况 | 用户可见结果 |
|---|---|
| 缺少 `DEEPSEEK_API_KEY` | 明确提示配置 DeepSeek API key，不显示环境内容 |
| 后端未安装或版本不符 | 提示在后端管理中安装或修复 DSH |
| initialize 失败 | `agent_start_failed`，附安全裁剪后的 DSH 原因 |
| prompt RPC 失败 | `error_during_execution`，保留会话供下次恢复 |
| 协议污染或非法 JSON | `backend_protocol_error`，终止该子进程 |
| 子进程意外退出 | `backend_process_exited`，记录退出码和受限 stderr |
| watchdog 超时 | 中止子进程，标记可在下一条消息恢复 |

## 9. AgentBackend 契约

### 9.1 能力声明

```ts
capabilities = {
  goal: false,
  steer: false,
  compact: false,
  resume: false,
  approvals: false
}

supportedModes = ['full']
```

这里的 `resume: false` 表示不支持 Bridge 的“历史会话列表与选择器”。它不否定同一飞书话题在进程重启后的内部恢复能力。

### 9.2 方法语义

- `startThread`：生成 DSH session ID，创建 runtime，返回可持久化 thread reference。
- `resumeThread`：使用已有 DSH session ID 创建 runtime，不预先发送填充 prompt。
- `runStreamed`：串行执行该 session 的一次 `session/prompt`，输出归一化事件。
- `lastActivity`：每收到一条原始响应或通知就刷新，供现有 idle watchdog 判断后端是否仍在工作。
- `abort`：终止 runtime 子进程组。
- `close`：优雅关闭并回收资源。
- `isAlive`：同时检查子进程与 JSON-RPC transport 状态。
- `runGoal`、`clearGoal`、`steer` 和 `compact`：抛出明确的“不支持”错误，不做静默模拟。
- `listThreads`：返回空列表；`readHistory`：返回空历史，且能力位 `resume=false` 会隐藏历史恢复入口。
- backend `doctor`：检查 Node、主包版本、入口文件、profile 和权限模式；不读取 API key 值。

单个 DSH session 同时只允许一个 active run。并发提交由现有 orchestrator 排队或拒绝，后端自身也要 fail closed，防止消息串线。

若 `AgentInput.images` 非空，首版在发送 prompt 前返回明确的“不支持图片输入”错误，不静默丢弃图片。普通文件由 Bridge 现有入站流程折叠为文本后仍可使用。

## 10. 模型与推理强度

首个版本声明 DSH 官方 rc.8 的 DeepSeek 模型：

- `deepseek-v4-flash`，默认
- `deepseek-v4-pro`

Bridge effort 映射：

| Bridge | DSH |
|---|---|
| `none` | `off` |
| `low` | `low` |
| `high` | `high` |
| `max` | `max` |

DSH 不声明支持 Bridge 的 `minimal`、`medium`、`xhigh` 或 `ultra`。UI 只展示当前后端明确支持的值，避免静默降级。

模型和 effort 列表集中在 DSH 后端定义中。后续 DSH 升级时，通过单独 PR 更新精确运行版本和对应模型能力。

## 11. 权限与安全边界

### 11.1 首版仅支持 full

DSH 的 sandbox 可以限制部分文件操作，但它不等同于完整的进程、网络和同 UID 数据隔离。首版因此只映射：

```text
Bridge full -> DSH danger-full-access
```

当用户选择 `qa` 或 `write` 时，路由校验应在启动前拒绝，并说明 DSH 当前仅支持 full。不得自动提升权限或静默改成 full。

### 11.2 禁用 Code/PTC

Bridge 生成的 profile 只装载 native tool 插件，同时设置 `DSH_TOOLS_MODE=native` 作为兼容性防线。不装载或暴露 `run_code`，也不允许通过普通配置切换为 Code/PTC。该限制用于避免在首版引入额外代码解释器和更复杂的沙箱边界。

### 11.3 其他控制

- DSH 不成为默认后端，并在 Catalog 文案中明确标记为实验性。
- 默认禁用 DSH telemetry。
- 不启动 DSH Web 服务，不监听 TCP 端口。
- 日志对 token、Authorization header、API key 形态做统一脱敏。
- 工具输入和输出沿用 Bridge 的长度限制与敏感字段裁剪。
- 子进程使用独立进程组，确保 abort 和 watchdog 能回收后代进程。
- 用户仍须把 DSH 视为能够访问项目 cwd、网络和当前用户可读数据的本机 agent。

## 12. 验证方案

实现采用协议夹具优先的测试方式，不依赖真实 DeepSeek 请求完成主要回归。

### 12.1 JSON-RPC 假服务

新增一个可执行 fixture，模拟 `dsh-jsonrpc-agent`：

- 接受 `initialize`、`session/prompt` 和 `shutdown`。
- 可发送正常文本、推理、工具调用、用量和 idle 事件。
- 可模拟早到通知、重复 committed message、RPC 错误、非法 JSON、无响应和进程退出。
- 将收到的 session ID 与初始化参数写入测试可观察通道。

### 12.2 单元测试

- Catalog 元数据、支持模式、模型和 effort 映射。
- 单包与多包安装命令的向后兼容性。
- 多包安装失败后的完整回滚。
- JSON-RPC 分帧、请求关联、通知过滤和错误处理。
- 事件映射与 committed message 去重。
- stderr 限长和敏感信息脱敏。
- 同 session 并发 run 的 fail-closed 行为。

### 12.3 生命周期测试

- 新会话生成稳定 UUID，并在下一轮复用。
- Bridge runtime 重建后使用同一 session ID。
- model / effort 改变时重启子进程，但不改变 session ID。
- abort 杀死进程且保留可恢复 thread reference。
- close 先尝试 shutdown，超时后回收进程组。
- 早到事件不会在 prompt 响应建立前丢失。
- `qa` / `write` 在启动前被明确拒绝。
- 图片输入在 prompt 发出前被明确拒绝，不会静默丢失。

### 12.4 安装与真实冒烟

在临时空目录执行：

1. 安装精确 rc.8 包集合。
2. 验证主包版本和 `dsh-jsonrpc-agent` 入口。
3. 加载 Bridge 生成的 profile。
4. 在不发起模型请求的情况下完成进程启动与 `initialize`。
5. 若开发环境存在 `DEEPSEEK_API_KEY`，可额外执行一次人工确认的最小真实 prompt；CI 不要求该密钥。

## 13. 验收标准

实现 PR 只有同时满足以下条件才可转为 ready for review：

1. 现有 Codex、Claude 和公共测试全部通过。
2. DSH 协议夹具覆盖正常流、早到事件、中止、恢复和故障路径。
3. 后端管理可以检测、安装、修复和卸载精确版本的 DSH。
4. DSH 只接受 `full`，其他权限模式不会被静默提升。
5. 同一飞书话题跨 runtime 重建保持相同 DSH session ID。
6. 流式文本、推理、工具调用、最终回答和用量不会重复或串到其他话题。
7. 缺密钥、协议错误和进程退出均得到可操作且不泄密的错误提示。
8. DSH 未安装或不可用时，不影响其他后端启动和运行。
9. 文档明确标注 developer preview、full-only 和本机数据访问边界。
10. 图片输入会明确失败，不会在用户不知情时被丢弃。

## 14. 发布与兼容策略

- 第一阶段：以 Draft PR 提交，Catalog 中可见但不默认安装、不默认选择。
- 第二阶段：维护者在本机使用独立机器人或测试群进行真实消息冒烟。
- 第三阶段：DSH 发布新的稳定版本后，单独评估协议、模型、sandbox 和包闭包，再更新精确版本。

DSH 当前是预发布软件。若上游 JSON-RPC 协议或 profile API 在后续 rc 中发生破坏性变化，旧的精确版本仍保持可复现；升级应通过独立 PR 完成，不在运行时自动漂移。
