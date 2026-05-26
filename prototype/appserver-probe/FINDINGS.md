# codex app-server 后端验证结论（codex-cli 0.131.0）

> 目的：在写真实 bridge 前，零成本验证 app-server 后端的方法/参数/枚举/运行时握手。
> 复现：`node prototype/appserver-probe/probe.mjs`（仅握手+model/list，不发模型请求、无 token 成本）。
> Schema：`prototype/appserver-probe/schema/`（`codex app-server generate-json-schema --out schema`）。

## ✅ 已验证

**传输/握手**
- `codex app-server --listen stdio://`，线协议 = **JSON-RPC 2.0 + 换行分隔(JSONL)**，带 `jsonrpc:"2.0"`。
- 流程：`initialize{clientInfo,capabilities}` → 返回 `{userAgent,codexHome,platformFamily,platformOs}` → 发 `initialized` 通知 → 才能调其它方法。
- 服务端通知/事件经同一 stdout 流回（如 `remoteControl/status/changed`）。

**方法（ClientRequest 全表确认存在）**
`initialize` `model/list` `thread/start` `thread/resume` `thread/fork` `thread/read` `turn/start` `turn/steer` `turn/interrupt`

**关键参数**
- `thread/start`: `{ model, cwd, approvalPolicy, sandbox, config, ... }`
- `thread/resume`: `{ threadId(必填), model, cwd, approvalPolicy, sandbox }`
- `turn/start`: `{ threadId(必填), input(必填,数组), model, effort, sandboxPolicy, approvalPolicy, outputSchema }`
  —— **model/effort/sandbox/approval 可按 turn 覆盖，且"沿用到后续 turn"** → 话题内改设置改下一轮 = 直接映射
- `turn/steer`: `{ threadId, expectedTurnId, input }`（必填全部）
- `turn/interrupt`: `{ threadId, turnId }` → watchdog 中止
- `model/list`: `{ cursor, includeHidden, limit }` → 返回 `{data:[{id,displayName,description,hidden,supportedReasoningEfforts:[{reasoningEffort,description}]}]}`

**枚举**
- ReasoningEffort: `none|minimal|low|medium|high|xhigh`
- SandboxMode: `read-only|workspace-write|danger-full-access`
- AskForApproval(approvalPolicy): `untrusted|on-failure|on-request|never`(+granular)
- 我们固定：`approvalPolicy:"never"` + `sandbox:"danger-full-access"`

**输入格式**：`input` 为数组，元素含 text / local_image 等（与 SDK 一致）。

## ✅ 实跑通过（turn-probe.mjs，真实跑一轮）
- 完整生命周期：initialize → thread/start(danger-full-access)→ threadId → turn/started → turnId → item/started → **item/agentMessage/delta（token 级流式 "hello"/" world"）** → item/completed(agentMessage, text="hello world") → turn/completed。
- **token 级 delta 确认存在**（修正"只有 item 级"的旧假设）→ 可做逐字流式。
- 噪声通知(mcpServer/hook/rateLimits/thread.status)由 event-map 忽略，符合预期。

## ⏳ 未实跑（成本/依赖）
- `turn/steer` / `turn/interrupt` 实跑（schema + 生命周期已验，风险低）。
- 飞书侧（`reply_in_thread` 建话题、`application.bot.menu_v6` 长连接投递、`im pins` 置顶）：需先配好 Lark 应用 + 长连接，onboarding 后验证。

## 结论
后端协议层 **全部对齐设计、无意外**。可以按设计直接实现 `AgentBackend` 的 app-server 实现。
