# feishu-codex-bridge 实现规划

> 配套 `feishu-codex-bridge-design.md`。从零搭 `src/`。references 仅学习不抄。
> 注：yepanywhere 在 `/tmp/yepany`（临时克隆、无 LICENSE，仅研究 app-server 客户端思路）。

## 协议层关键事实
- **更正（generate-ts 实证）**：app-server v2 **有 token 级 delta** 通知 —— `AgentMessageDeltaNotification`、`ReasoningTextDeltaNotification`、`CommandExecOutputDeltaNotification`，外加 `ItemStartedNotification`/`ItemCompletedNotification` + `turn/completed`/`ErrorNotification`。→ **可做真·逐字流式**，run-state 保留 delta 累加（item/completed 做收尾对账）。
- 协议绑定已生成入库：`src/agent/codex-appserver/protocol/generated/`（79 文件 + v2/），barrel `protocol/index.ts`。

## 状态
- **M0 ✅ 完成并验证**：脚手架(package/tsconfig/tsup/bin) + paths + logger + 协议绑定 + cli(doctor 实/start·service 桩)。`npm install`/`typecheck`/`build`/`doctor` 全绿。
- **M1 agent 后端 ✅ 已建 + 实跑验证**：`agent/types.ts`(AgentBackend/Thread/Run/Event) + `codex-appserver/{app-server-client,event-map,backend,locate}.ts` + `agent/index.ts`。typecheck 全绿；`prototype/appserver-probe/turn-probe.mjs` 实跑确认完整 turn 生命周期 + token 级流式。
- **M1 onboarding ✅**：keystore + secret-resolver + store/schema + feishu-auth + wizard(扫码 registerApp) + secrets CLI + start 编排。typecheck/build 绿。
- **M1 bot/bridge ✅ 代码完成**：`bot/bridge.ts`(createLarkChannel 长连接) + `bot/handle-message.ts`(群@bot→reply_in_thread 建话题→app-server turn→`channel.stream` markdown 流式卡片，话题内续用 session) + `card/run-render.ts`。typecheck/build 绿。
- **M1 ✅ 端到端验证通过**（2026-05-26）：用户扫码复用 cli_aa81b50143785cd9 → 群里 @bot → reply_in_thread 建话题 → app-server 在 cwd 跑一轮 → codex 调工具 + 输出 + 流式 markdown 卡片。终端日志干净。p2p 暂跳过（DM 控制台属 M2）。
- **M3 ✅ 代码完成**（2026-05-26, ece8f36）：群主区 @bot → 会话配置卡（模型▾/effort▾ + 创建/恢复），点创建→reply_in_thread 建话题开跑；话题内 @bot 直接续跑。`card/dispatcher.ts`(card.action.trigger 路由) + `card/cards.ts` + `card/session-config-card.ts` + `bot/handle-message.ts`(重构 createOrchestrator) + `bot/session-store.ts`。去掉 fast（codex 无此参数，见 decisions.md）。
- **M4 ✅ 代码完成**（ece8f36）：配置卡模型下拉用 `backend.listModels()`；恢复历史→`backend.listThreads(cwd)`(codex thread/list) 列最近会话→`thread/resume`，仅新建时可选。
- **运行卡 ⏹/⚙️ ✅ 代码完成**（08ce549）：运行输出改流式卡片，运行中挂 ⏹中止、终态挂 ⚙️设置(改本会话 model/effort，下一轮生效，仅挂最新卡)。`card/run-card.ts` + `runStreamed(input,turn?)` per-turn override。
- **M5 ✅ 代码完成**（a9cb1ce）：`project/banner.ts` 置顶横幅卡片化 + 分支惰性检测(变了才 patch)；registry 增 bannerMessageId/branch + updateProject。
- **M7 ✅ 代码完成**（45e2ec8）：`card/dm-cards.ts` 私聊菜单/项目列表/删除确认/全局设置卡；dm.* handlers 接 dispatcher(admin gate)。文本命令保留兜底。新建项目暂用 /new 文本（卡片 form input 后续）。
- **M8 ✅ 代码完成 + 真机验证**（4337d50, service-dev）：launchd 后台服务（adapter/launchd + cli service install/uninstall/status/restart/logs），真机 install→pid→restart→uninstall 清理无残留。
- **单测 ✅**（e548b8e, test-dev）：test/{event-map,run-render,schema,watchdog} 24 用例 + vitest.config 限定 test/**，npm test 24/24 绿。
- **reviewer [OK]**（2fd9248, 2026-05-26）：3 轮收敛，全部 HIGH（卡片授权/回调长占/假成功/⏹杀别人 run）+ MEDIUM（泄漏/陈旧/设置语义/pin撤销）关闭；报告见 .plans/reviewer/review-rereview-2fd9248/。
- **⬜ 待用户端到端真机测试**（M3/M4/M5/M7 + 运行卡 + M8）：typecheck/build/test 全绿、reviewer [OK]，唯一残留=真机 Feishu callback smoke。

## 已知待办（后续统一处理）
- **卡片渲染细节统一**：运行卡虽已切 card 模式，工具仍在文本上方堆叠、原样 `/bin/zsh -lc "..."`。后续：有序交错 block + 友好工具头(去 shell 壳) + 可折叠工具面板。（用户明确「先不改，后面统一改」）
- **新建项目卡片 form**：当前 /new 文本兜底；后续用飞书卡片 input + 提交收 form_value。
- **app-server 子进程回收**：当前每个活跃话题常驻一个进程；watchdog 管卡死，但完整生命周期回收（话题闲置/超时关进程 + 启动清孤儿）未做。
- JSON-RPC over stdio：行缓冲 split `\n`，按 id/method 分流 response/notification/server-request，pendingRequests Map + notification 异步队列。
- reply_in_thread 响应不透出 thread_id → 从 `GET /im/v1/messages/:id` 或 receive 事件取。

## 1. 目标 src/ 结构（[复用]references思路 / [改造]骨架可用核心重写 / [全新]）
```
src/
  cli/{index,commands/{start[改],doctor[改],service[复用],secrets[复用],ps[复用]},
       onboarding/{codex-cli[复用],lark-cli[复用],wizard[改],menu-setup-guide[全新]}}
  agent/                                  ★核心全新区
    types.ts[改] index.ts[复用]
    codex-appserver/{backend,app-server-client,process,event-map,model-list}[全新]
      protocol/{index,generated/*}[全新]  ← codex app-server generate-ts 产物入库
  bot/{bridge[改],router[全新],access[复用],keepalive[复用],network[复用],
       run-orchestrator[全新],active-turns[改],pending-policy[全新],
       chat-mode-cache[复用],reaction[复用],quote[复用],media-intake[复用]}
  card/{templates[复用],managed[复用],run-renderer[改],run-state[改],tool-render[复用],
        session-config-card[全新],thread-settings-card[全新],project-cards[全新],
        banner-card[全新],wizard-cards[全新],dispatcher[改]}
  project/{registry,lifecycle,git-info}[全新]   ← 项目=群=cwd 注册表
  session/{store[改],history[改]}               ← 话题=会话 持久化
  config/{schema[改],store[复用],paths[复用],keystore[复用],secret-resolver[复用],defaults[全新]}
  service/{adapter,launchd}[复用]
  media/cache[复用]  runtime/registry[复用]  core/logger[复用]
```

## 2. AgentBackend
```
interface AgentBackend { id; displayName; isAvailable(); listModels(opts?);
  startThread({cwd,model,effort,fast}): AgentThread;
  resumeThread({codexThreadId,cwd,model,effort,fast}): AgentThread; }
interface AgentThread { codexThreadId; runStreamed(input): AgentRun;
  steer(input,expectedTurnId); abort(turnId); close(); }
interface AgentRun { events: AsyncIterable<AgentEvent>; turnId(); waitForExit(ms); }
```
- AgentEvent 沿用 reference 形状（system/text/thinking/tool_use/tool_result/usage/done/error）+ 可选 turnId。
- **一话题一进程**：backend 持 `Map<feishuThreadId, AppServerClient>`；startThread/resumeThread spawn+握手，close 回收。
- 握手：initialize→等result→notify(initialized)→thread/start{model,cwd,approvalPolicy:'never',sandbox:'danger-full-access'}（resume 走 thread/resume{threadId}）。
- 回收：SIGTERM→grace→SIGKILL；detached 进程组 kill 防孤儿；启动清孤儿；崩溃 reject pending+标卡 error。
- watchdog/steer/interrupt 挂在 bot/run-orchestrator；server-request 兜底回 -32601 防卡死。
- 协议绑定：generate-ts 子集入库 + `tools/update-codex-protocol.mjs` + doctor 校验版本。

## 3. 里程碑（各自可独立验证）
- **M0 脚手架**：package/tsup/vitest/commander/node-sdk、paths/config/logger/keystore 搬入、cli 空壳+doctor、protocol 子集入库。验证 build+doctor。
- **M1 最小垂直闭环 ★**：长连接收 message → 群@bot → reply_in_thread 建话题 + 取 thread_id → startThread(写死cwd/默认model) → turn/start → 运行卡流式 patch。**需用户先备 §4。**
- **M2 项目管理**：菜单 bot.menu_v6 → 新建项目(空白git init/指定文件夹)→建群+拉人+置顶→registry；列表/删除(解绑+提示自解散)。cwd 改按群查 registry。
- **M3 会话配置卡+三层默认**：群@bot 弹 session-config-card(model/effort/fast 预填)→创建→reply_in_thread；话题运行卡加 ⚙️设置(改下一轮，挂最新卡旧卡patch掉)。
- **M4 动态模型+恢复会话**：model/list 喂下拉(effort 随模型联动)；恢复历史→session/history→thread/resume(仅新建时)。
- **M5 置顶横幅+分支惰性检测**：banner-card+im pins create；消息进/run结束读 git 分支变了 patch。
- **M6 稳定性**：watchdog(120s可配)、steer/queue 策略、心跳+自动重连(🔄菜单)、并发FIFO、孤儿回收。
- **M7 访问控制+全局设置卡**：admins/allowedUsers/allowedChats；破坏性限 admins。
- **M8 onboarding+service+诊断**：wizard扫码建应用、codex/lark-cli onboarding、菜单配置指引、launchd、🩺诊断卡。

## 4. M1 需用户准备
1. **appSecret**（WSClient 必需，存 keystore）
2. **开放平台事件订阅(长连接)**：im.message.receive_v1 + card.action.trigger + application.bot.menu_v6，发布版本
3. **scope**：im:message / im:message:send_as_bot / im:resource / im:chat / im:chat.announcement(项目横幅改用群公告，docx block 读写) / **cardkit:card:write**(交互按钮卡片用 CardKit 实体，缺则 cardkit.card.create 报 200610)；可选 drive:drive。**不需 im:chat:delete**
4. 机器人自定义菜单 5 项 event_key（M2 用，可同时配）
5. codex 已 login（M1 真实跑 turn 耗 token）；记 codex 版本对齐 generate-ts
6. 一个测试群(bot 在内)+测试 cwd（M1 写死用）

## 5. 风险与对策
- card.action/bot.menu 未实跑 → M1 末单独冒烟点一下按钮看回调；失败回退文本指令兜底。
- 无 token delta → item 级整段渲染，run-state 改 itemId upsert。
- reply_in_thread 不透出 thread_id → 从消息 get/receive 事件取。
- 每话题一进程膨胀 → maxConcurrentRuns FIFO + 闲置回收 + 启动清孤儿。
- 协议漂移 → generated 入库 + update/check 脚本 + doctor 校验。
- steer expectedTurnId 竞态 → 严格缓存活跃 turnId，失败降级 queue。

## 6. 技术选型（沿用 references）
tsup(ESM, bin wrapper) · vitest(重点单测 json-rpc 帧/event-map/run-state/pending-policy/registry) · commander · @larksuiteoapi/node-sdk ^1.65(WSClient, includeRawEvent, pingTimeout) · lark-cli(出站+onboarding) · Node≥20 · TS ^5.6 · https-proxy-agent · qrcode-terminal
