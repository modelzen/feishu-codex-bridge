# DSH 后端接入研究报告：多 provider 路线与远程机部署

> 状态：研究结论已转化为首版实现
> 日期：2026-08-22；实现复验：2026-08-31
> 关联设计：[dsh-backend-design.md](./dsh-backend-design.md)（2026-08-20，本报告对其提出修订）
> 部署形态：Bridge 运行于远程机，DSH 作为 Bridge 的本地子进程后端（同机）

## 1. 结论

1. **可行，且架构无需推翻。** 既有设计文档定义的 `dsh-sdk` 后端（SDK JSON-RPC stdio 子进程、每话题一进程一稳定 sessionId、JSONL 持久化恢复、仅 `full` 模式）经本次逐项核验依然成立，可直接作为实现蓝本。
2. **模型层从 DeepSeek-only 改为多 provider。** 设计文档假设 `dsh-llm-deepseek` + `DEEPSEEK_API_KEY`；实际需求是 MiniMax / Kimi（Moonshot）/ GLM（智谱）的 API key。核验确认官方通用适配器 `@deepseek-ai/dsh-llm-pi-ai` 内建这三家的目录路由——端点、协议、模型清单、思维链方言全部预置，**接入零代码**，只需配置 route + 把 API key 写入 `$DSH_HOME/.credentials.yaml`。
3. **订阅认证（ChatGPT/Claude/Grok）可作为可选第二阶段。** 第三方插件 `dsh-plugin-subscriptions` 的 OAuth 流程依赖 127.0.0.1 回环 + 浏览器，无头远程机需 auth.json 迁移或手动粘贴回调码；API key 路线对无头服务器严格更优，应为主路线。
4. **版本已裁定为 `0.1.1-rc.2`。** 2026-08-31 空目录安装探针确认生产 profile 直接引用的 19 个包均能以该精确版本共存；真实 `dsh-jsonrpc-agent` 完成 keyless `initialize` / `shutdown`，且未打开 TCP listener。Bridge 不跟随浮动 prerelease tag，后续升级单独评审。

## 2. 本机 DSH 部署现状盘点（2026-08-22）

| 项 | 现状 |
|---|---|
| 安装形态 | npx 缓存（`~/.npm/_npx/1e7f6d9597241db0`），`@deepseek-ai/dsh@0.1.0-rc.7`，非 git checkout |
| 运行方式 | `DSH.app` 启动 `npx -y @deepseek-ai/dsh web`，监听 127.0.0.1:3080（仅回环） |
| `$DSH_HOME` | `~/.dsh`；仅有 `web` profile，无 `headless` profile |
| LLM 认证 | 第三方插件 `dsh-plugin-subscriptions@0.3.1`（Grok 订阅 OAuth），`agent-default-model: grok/grok-4.6` |
| `.credentials.yaml` | 不存在（尚未使用 API key 路线） |
| 会话持久化 | `~/.dsh/sessions/…/session.jsonl.zstd`，与设计文档描述一致 |

要点：本机现状（web + Grok 订阅）与 Bridge 后端所需形态（jsonrpc + API key）是**两套并行 profile**，互不干扰。Bridge 生成的私有 profile 不会复用 web profile 的任何配置。

## 3. 程序化接入面核验

设计文档 §3.1 的四方案对比（Headless CLI / ACP / Web API / SDK JSON-RPC）本次逐项复核，结论不变，采用 **SDK JSON-RPC stdio**。补充两点本次验证：

- rc.7 本机安装树中**没有** `dsh-sdk-jsonrpc-server` 包——该协议面从 rc.8 起提供，因此实现版本下限为 rc.8。
- Headless CLI 实测语义与文档一致：一次任务、仅输出最终答案、无法附着既有会话，确认无法承载 Bridge 的多轮流式会话。

## 4. 多 provider 方案（本报告核心增量）

### 4.1 适配器选型：`@deepseek-ai/dsh-llm-pi-ai`

官方 LLM 适配器只有两个实现：`dsh-llm-deepseek`（仅 DeepSeek）和 `dsh-llm-pi-ai`（通用多协议，底层为 `@earendil-works/pi-ai@^0.82.1`）。**不存在** `dsh-llm-openai` / `dsh-llm-anthropic` 这类单协议包（npm 已确认 404）。

`dsh-llm-pi-ai` 支持三种线协议：`openai-completions`、`openai-responses`、`anthropic-messages`，并随 pi-ai 携带内建 provider 目录。它已在 `dsh-base` 的组合层挂载（无 `config:` 即休眠），配置出现即注册路由，无需改动 profile 组合结构。

### 4.2 目标三家 provider 的内建路由（对照 pi-ai 0.82.1 目录数据核实）

| 路由 key | 线协议 | baseUrl | 模型（完整清单） | env var |
|---|---|---|---|---|
| `minimax` | anthropic-messages | `https://api.minimax.io/anthropic` | MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M3 | `MINIMAX_API_KEY` |
| `minimax-cn` | anthropic-messages | `https://api.minimaxi.com/anthropic` | 同上 | `MINIMAX_CN_API_KEY` |
| `moonshotai` | openai-completions | `https://api.moonshot.ai/v1` | kimi-k2 系列 ×5, kimi-k2.5, kimi-k2.6, kimi-k2.7-code(-highspeed), kimi-k3 | `MOONSHOT_API_KEY` |
| `moonshotai-cn` | openai-completions | `https://api.moonshot.cn/v1` | 同上 | `MOONSHOT_API_KEY` |
| `zai` | openai-completions | `https://api.z.ai/api/coding/paas/v4` | glm-4.5-air, glm-4.7, glm-5-turbo, glm-5.1, glm-5.2, glm-5v-turbo | `ZAI_API_KEY` |
| `zai-coding-cn` | openai-completions | `https://open.bigmodel.cn/api/coding/paas/v4` | 同上 | `ZAI_CODING_CN_API_KEY` |
| `kimi-coding` | anthropic-messages | `https://api.kimi.com/coding` | k3, k3-256k, kimi-for-coding(-highspeed) | `KIMI_API_KEY` |

思维链方言均已预置：Moonshot 走 `thinkingFormat: deepseek`（kimi-k3 例外，走 `openai` + `deferredToolsMode: kimi`）；GLM 走 `thinkingFormat: zai` + `zaiToolStream`；MiniMax / kimi-coding 走 anthropic-messages 原生 thinking。

### 4.3 推理强度（effort）支持差异

对照 pi-ai 目录数据逐模型核验 `compat.supportsReasoningEffort`：

| 模型 | reasoning | 分档 effort |
|---|---|---|
| kimi-k3 | ✅ | ✅（openai 风格 effort） |
| kimi-k2.7-code | ✅ | ❌（仅开/关） |
| glm-5.2 / glm-5.1 | ✅ | ✅（zai 风格） |
| MiniMax-M3 / M2.7 | ✅ | ❌（仅开/关） |
| kimi-coding k3 | ✅（adaptive thinking 强制开） | ❌ |

**对 Bridge 的含义**：设计文档 §10 的统一 effort 映射（off/low/high/max）不能对全部模型成立。ModelInfo 的 `supportedEfforts` 必须逐模型如实声明——不支持分档的模型只暴露开/关两态（或不暴露 effort 选项），避免 UI 给出静默降级的假选项。

### 4.4 凭据机制

`@deepseek-ai/dsh-credentials-local` 四层解析（优先级高→低）：进程继承 env（冻结、只读）→ `$DSH_HOME/.credentials.yaml`（可写、热加载）→ `<cwd>/.env` → `$DSH_HOME/.env`。

`.credentials.yaml` 为平面 YAML 映射，文件 0600 / 目录 0700，权限位不符即拒绝加载：

```yaml
# $DSH_HOME/.credentials.yaml（示意，key 均为占位）
MOONSHOT_API_KEY: sk-xxxx
ZAI_CODING_CN_API_KEY: xxxx
MINIMAX_API_KEY: xxxx
```

要点：harness 自行解析 `apiKeyEnv` 引用；凭据可来自继承环境或 credentials 文件。Bridge 只传递配置中的变量名，不打开 credentials 文件，不读取、复制、打印或持久化 key 值。

### 4.5 Bridge 生成 profile 的配置样例

Bridge 私有 profile 中 `llm-pi-ai` 段（替代设计文档原 DeepSeek adapter 段）：

```yaml
llm-pi-ai:
  providers:
    moonshotai-cn:            # Kimi，目录路由：仅需凭据引用
      apiKeyEnv: MOONSHOT_API_KEY
    zai-coding-cn:            # GLM
      apiKeyEnv: ZAI_CODING_CN_API_KEY
    minimax:                  # MiniMax（Anthropic 兼容端点）
      apiKeyEnv: MINIMAX_API_KEY
```

目录路由之外也支持整路由手工声明（必填 `api` + `baseURL` + 非空 `models`），可用于 GLM 通用端点（`…/api/paas/v4`）、代理网关或 Kimi/GLM 的 Anthropic 兼容端点。无鉴权的本地网关需占位凭据（pi-ai 的 OpenAI 兼容实现强制要求 key 或显式 `Authorization` 头）。

### 4.6 DeepSeek 路由的去留

DeepSeek 官方 API 在 pi-ai 目录中同样存在（`deepseek` 路由，openai-completions，`deepseek-v4-flash/pro`）。因此**无需保留 `dsh-llm-deepseek` 插件**——统一走 `dsh-llm-pi-ai` 一个适配器覆盖全部 provider（含 DeepSeek），profile 更薄、事件路径单一。

## 5. 订阅插件无头部署评估

`dsh-plugin-subscriptions@0.3.1`（第三方，github:V1ki）注册 `codex` / `claude` / `grok` 三条订阅路由，与 `llm-pi-ai` 是并列的 adapter 家族，路由 key 无冲突。

**无头障碍**：OAuth PKCE 流程起 127.0.0.1 回环 HTTP server 并跳浏览器。远程 Linux 服务器上的可行绕法（按推荐顺序）：

1. **auth.json 迁移**：在有浏览器的机器（如本 Mac）上用 web profile 完成登录，将 `~/.dsh/plugins/subscriptions/auth.json`（0600）拷贝到远程机同路径；token 此后自动刷新。
2. **手动回调粘贴**：插件自带 manual fallback（粘贴回调 URL 或裸 code），README 明确支持无头场景，但需一次交互操作。

**风险**：第三方插件、版本 0.3.x、依赖各订阅服务的私有端点，稳定性和合规边界均弱于官方 API key 路线。结论：**列为 P4 可选阶段，不进入首版验收标准**。

## 6. 远程机部署清单（Linux/systemd 假设，落地前逐项验证）

前置验证（远程机现状未确认，首项即核实）：

1. OS / 架构 / Node 版本（Bridge 与 DSH 均要求 Node ≥ 20；`node -v`）
2. Bridge 是否已在该机部署运行（`systemctl --user status feishu-codex-bridge` 或对应 unit）

部署步骤：

1. Bridge：按仓库 README 安装，`feishu-codex-bridge run` 冒烟后注册 systemd 服务；确认飞书长连接（WebSocket 出站，无需入站端口/公网 IP）
2. DSH 后端：通过 Bridge 后端管理安装精确版本包集合到 Bridge 私有后端目录（设计文档 §5.2/§5.3），验证 `dsh-jsonrpc-agent` 入口
3. 凭据：创建远程机 `$DSH_HOME`（按 bot 隔离的 `DSH_SESSION_ROOT` 由 Bridge 管理），写入 `.credentials.yaml`（0600/0700），放入 MiniMax/Kimi/GLM key
4. 网络：确认远程机可达各 provider 端点（国内机用 `-cn` 路由：`api.moonshot.cn` / `open.bigmodel.cn` / `api.minimaxi.com`；海外机用国际路由）
5. 冒烟：测试群发消息 → 流式回答 → 中止 → Bridge 重启 → 同话题续聊（验证 sessionId 恢复）

## 7. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| DSH 为 developer preview，rc 间协议可能破坏性变更 | 升级即可能断 | 精确锁版本，升级走独立 PR（设计文档 §14 既有策略） |
| pi-ai 目录随 `^0.82.1` 浮动更新，模型清单可能漂移 | Bridge 静态 ModelInfo 与实际可用模型不一致 | 安装时锁 lockfile；模型清单更新与版本升级同 PR |
| effort 支持逐模型差异 | UI 假选项 / 静默降级 | §4.3 的逐模型 `supportedEfforts` 声明 |
| 订阅插件第三方 + OAuth 无头障碍 | 不可控 | 降为 P4 可选，主路线 API key |
| 远程机环境未核实（OS/Node/网络可达性） | 部署清单假设失效 | §6 前置验证步骤 |

实现裁定：

- **版本锁定**：`0.1.1-rc.2`，19 个直接包统一精确版本；真实 keyless profile 冒烟通过。
- **`listModels()`**：v1 静态编码 8 条已核验 route/model，与运行版本一同锁定；动态自定义 provider 留待后续需求。
- **曝光策略**：Catalog 可见、按需安装、永不作为默认后端；`full` 之外的项目不会显示或启动 DSH。

## 8. 实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1 代码落地（完成）** | `src/agent/dsh/{backend,thread,event-map}.ts`；REGISTRY + BACKEND_CATALOG 双注册；安装器 `installSpecs` 多包扩展；JSON-RPC 假服务 fixture + 单元/生命周期测试 | 设计文档 §12–13 的自动化条目；现有 Codex/Claude 测试不回归 |
| **P2 本机冒烟** | 本 Mac 用真实 Kimi/GLM/MiniMax key，测试群跑通：流式、工具调用展示、中止、Bridge 重启后同话题恢复、模型/effort 切换 | 设计文档 §13 条目 4–7、10 |
| **P3 远程机部署** | 按 §6 清单部署远程机，真实消息冒烟 | 远程机上 P2 同款场景全过 |
| **P4 可选** | 订阅插件接入（auth.json 迁移方案） | 独立评审 |

P1 易漏项备忘（源自对当时 Bridge 两个既有后端的逐文件核对）：子进程 env 带 `FEISHU_CODEX_BRIDGE=1`（防 cli-bridge 自转发）；system prompt 追加 `BRIDGE_DEVELOPER_INSTRUCTIONS`；用 `src/platform/spawn.ts` 的 `spawnProcess`（`detached: true`）+ `killProcessGroup`，不裸用 child_process；`AgentRun.lastActivity()` 每收到一条原始消息即刷新（否则 120s idle watchdog 会杀长静默轮次）；`AgentInput.images` 非空时发 prompt 前显式报错。
