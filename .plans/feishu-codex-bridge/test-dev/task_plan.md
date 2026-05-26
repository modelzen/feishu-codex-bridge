# test-dev — Task Plan

> Role: Backend Dev / Test (codex) · Status: pending
> 负责：对纯模块写 vitest 单测，放 `test/`。只读 import src，不改 src。

## Goal
给逻辑核心补单测，`npm test`（vitest run）全绿。覆盖纯模块（无 fs/进程副作用的）。

## Scope（只在 test/ 下新建文件）
- `test/event-map.test.ts` — `src/agent/codex-appserver/event-map.ts` 的 `mapNotification`：
  - thread/started→`{type:'system'}`；turn/started→`turn_started`(turnId)；item/agentMessage/delta→`text_delta`；
  - item/completed(item.type=agentMessage)→`text`；(reasoning)→`thinking`；(commandExecution)→`tool_result`(exitCode)；
  - item/started(commandExecution)→`tool_use`；turn/completed→`done`；error→`error`(willRetry)；
  - 噪声(mcpServer/hook/account/…)→`null`。构造最小 ServerNotification 对象喂入。
- `test/run-render.test.ts` — `src/card/run-render.ts` RunRender：text_delta 累加、多 itemId 顺序、tool_use+tool_result 状态标记(✓/✗)、done/error 文案、空态返回"正在输出…"。
- `test/schema.test.ts` — `src/config/schema.ts`：getRunIdleTimeoutMs(默认120000 / 0→undefined / clamp 10–1800)、getPendingPolicy(默认steer)、getMaxConcurrentRuns(默认10/clamp50)、isAdmin/isUserAllowed/isChatAllowed(空=放行/命中)、getMessageReplyMode(默认card)。
- `test/watchdog.test.ts` — `src/bot/watchdog.ts`：
  - `Semaphore`：max=2 时第3个 acquire 阻塞，release 后放行；FIFO 顺序。
  - `withIdleTimeout`：源正常透传全部值；某次间隔超 idleMs → 调 onTimeout 且生成器结束；idleMs=0 直接透传不超时。用可控的 async 源 + 假定时器或短超时。

## 验收
- `npm test` 全绿（vitest 已在 devDeps）。
- 不改任何 src 文件（只读 import）。若发现被测模块不可测（耦合），**不要改 src**——reply `@lead` 说明，由 lead 决定是否重构。
- 完成 reply `@lead`：新增测试文件、用例数、`npm test` 结果。

## Non-goals
不测需要 spawn 真实 codex / 真实飞书的部分（app-server-client、backend、bot/bridge、lifecycle 的 IO）——那些是集成测，本轮跳过。
