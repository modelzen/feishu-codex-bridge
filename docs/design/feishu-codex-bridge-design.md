# feishu-codex-bridge 设计规格

> 本文是一轮 grill 对齐后的设计依据。把飞书 / Lark 消息桥接到本机 Codex，在飞书里以"项目—会话"的模型驱动 `codex` 干活。
> 参考实现：`docs/references/feishu-claude-code-bridge`（原版，对接 claude，功能基线）、`docs/references/feishu-codex-bridge`（QQQingyu 的 codex 移植，仅作对照）。
> 高保真 UI 预览：`prototype/feishu-ui-prototype.html`。

---

## 1. 目标与范围

**目标**：一个**自建、稳定、架构干净**的 codex bridge。功能以 feishu-claude-code-bridge 为基线，但重做交互模型与后端，重点解决原版的"卡住"问题。

**核心原则**
- **少斜杠命令，能用卡片/菜单就不用斜杠。**
- **稳定优先**：进程隔离 + watchdog，单会话卡死不影响全局。
- **可演进**：agent 后端、service 平台都用接口隔离，便于以后扩展。

**非目标（v1 不做）**
- worktree / 分支切换（分支只读展示）
- 执行权限分级（固定 dangerous 全放行）
- Windows / Linux 后台服务（先 macOS；接口预留）
- app-server 之外的后端、审批卡片流、自由问答外的重型能力

---

## 2. 核心模型

```
飞书群  ===  一个 Project  ===  绑定一个固定 cwd（建项目时确定，群内不可改）
  │
  ├─ 主群对话区：@bot → 弹"会话配置卡"，不直接跑 codex
  │
  ├─ 话题(thread) A  ===  session A   ← 每个话题 = 一个独立 codex 会话
  ├─ 话题(thread) B  ===  session B
  └─ ...
```

- **项目 = 群 = 固定 cwd**。一个项目群里所有话题共享同一个 cwd。
- **话题(thread) = 会话(session)**。每个话题对应一个 codex 会话（`thread_id`）。
- **三层默认，逐层覆盖**：全局默认（config.json）→ 项目默认（建项目时）→ 话题配置卡（创建时按上层预填，可逐项覆盖）。
- **session 延续**：codex app-server `thread/resume`；会话 id 持久化。

---

## 3. 三大交互面

### 3.1 私聊（管理控制台 + 使用向导）

私聊**只做管理 + 使用引导，永不跑项目任务**。

- **常驻入口：机器人自定义菜单**（钉在输入框，仅单聊支持）
  `[➕ 新建项目] [📁 项目列表] [⚙️ 设置] [🩺 诊断] [🔄 重连]`
  点击触发 `application.bot.menu_v6` 事件（node-sdk 长连接可收）。
- **➕ 新建项目** → 卡片：名称输入 + `[新建空白项目]` / `[指定现有文件夹]`
  - 空白项目：在 `~/.feishu-codex-bridge/projects/<名>/` 建空目录并 `git init`
  - 现有文件夹：卡片里输入路径
  - 完成后建群、把用户拉入、设置群置顶横幅；重名报错
- **📁 项目列表** → 卡片列出（名/cwd/分支/进群按钮/🗑删除）
- **🗑 删除** → 二次确认 → **解绑项目**（从注册表移除、撤销置顶横幅、之后不再在该群响应）→ **把群主转让给操作的 admin**（`im.v1.chat.update` owner_id；因为群是 bot 建的、bot 是群主，用户无法自行解散）→ 提示"群主已转给你，请你在飞书自行解散该群"。bot 不主动解散（不调 `chat.delete`，省 `im:chat:delete` scope）；**绝不删代码目录**（仅"空白项目 + 私有 projects 目录 + 空目录"才额外询问删空目录）
- **🚪 群管理**（DM）→ `chat.list` 列出 bot 所在群 + 🔑转让群主给我（处理遗留/测试群）
- **⚙️ 设置** → 全局偏好卡（见 §6 / §5）
- **🩺 诊断** → 自检（codex/lark-cli/登录/连接/会话）
- **自由文本** → 使用向导（混合 C）：常见意图走引导帮助卡；自由问答兜底起一个**只读、无项目绑定**的 codex 帮助会话（system prompt 注入用法）

### 3.2 项目群

- **群置顶横幅 = 群公告**（docx block 写内容 + `im chatTopNotice.putTopNotice action_type:"2"` 置顶；chat 级）：
  一行 `📁项目名 · [📂路径(仅绑定已有目录显示)] · [🌿分支(仅 git)]`。**两步**：① docx block API 把群公告内容写成一个 text block；② put_top_notice action_type=2 把"群公告"置顶成顶部横幅（复用 `im:chat`，无需额外权限，无需 message_id）。分支变化**惰性检测**（消息进来 / run 结束时读 `git rev-parse --abbrev-ref HEAD`，变了重写群公告 block；置顶状态保持，不重复置顶）。早期"Pin 一条卡片消息"方案已废（只进 Pin 列表、不在顶部横幅，见 git 史）。
- **主区 @bot[+首条消息]** → **会话配置卡**（预填默认，可直接创建）：
  `模型 ▾`（动态 model/list）`effort ▾` + `[✅ 创建新会话]` `[🔁 恢复历史会话]`
  （注：codex 无 `fast` 参数，effort 即速度/质量杆，故去掉 fast 下拉，见 .plans/decisions.md 2026-05-26）
  - 创建 → `reply_in_thread` 把这条消息变成话题、开跑
  - 恢复 → `thread/list`（按 cwd 过滤，codex 自己的会话库）列最近会话（`preview` 首条消息 + 相对时间）→ 选一条后：
    - `thread/read`（`includeTurns:true`）拉该会话的历史 turns（**不**开 turn、**不**驻留进程；含已解密思考），归一化成 `ThreadHistory`；
    - `reply_in_thread` 发一张**折叠历史卡**（`buildHistoryCard`，schema 2.0 `collapsible_panel` 嵌套：每轮收拢，展开见 👤提问/🤖回答，再下一层折叠思考+工具明细；卡底「📍上次停在」预览；长历史只显示最近 N 轮并注明）——这张卡同时就是新话题的根消息；
    - `getThreadId` 回取话题 thread_id → `upsertSession` 把 `codexThreadId` 绑到该话题（model/effort 留空，沿用该 codex thread 自己记忆的配置）。
    - **不发任何填充轮**：会话靠话题下一条消息经 `resolveThread`（`getSession`→`thread/resume`）惰性续上——用户直接接着聊即可。
  - **resume 只在新建会话时可选；话题中途不允许恢复**

### 3.3 话题（thread，= 一个 session）

> 飞书话题**没有"头部卡 / 话题级置顶"**（置顶是 chat 级，话题视图也看不到群置顶）。因此控件挂在卡片上。

- **@bot 文本** = 与 codex 对话
- **运行输出卡**（流式，原地 patch 更新）：正在输出 / 工具调用块（可隐藏）/ 文本
  - 底部按钮行（即"菜单"，卡片按钮在话题里有效）：`⏹ 中止` + `⚙️ 设置`
  - `⚙️ 设置`：展开改本会话 `模型/effort`（改下一轮）+ 显示 cwd/分支
  - **设置控件仅挂最新一张卡**；新一轮开始时 patch 上一张卡移除它 → 翻历史干净
- **会话开场**：话题首条 bot 消息播报 模型/effort/cwd/分支（一次性，会滚走，不依赖它常驻）

> 群 / 话题里**没有钉住的菜单**（机器人菜单仅单聊）；卡片底部按钮行就是事实上的菜单。

---

## 4. Agent 后端

- **后端：codex `app-server`（stdio 传输）**，`codex app-server --listen stdio://`，JSON-RPC。
  - **每个会话(话题)一个独立 app-server 子进程**，绑该项目 cwd → 进程隔离，单会话卡死不波及他人（参考 yepanywhere 的 `runSession` 模式，但**不抄其代码**——该仓库无 LICENSE）。
  - 握手 `initialize` → `initialized` → `thread/start` / `thread/resume`，参数 `{ model, cwd, approvalPolicy, sandbox }`。
  - **动态模型列表**：`model/list`（临时 spawn 查询，缓存，带静态兜底）→ 喂配置卡模型下拉。
  - 协议绑定：自己 `codex app-server generate-ts` 生成（版本匹配）。
- **AgentBackend 接口隔离**（`startThread / run / runStreamed / resume / abort` 等），未来可换 exec / SDK / 远程而上层不动。
- **run 参数映射**：
  - 模型 → `thread/start.model`
  - effort → `turn/start.effort`（none/minimal/low/medium/high/xhigh；按模型 supportedReasoningEfforts 联动）
  - ~~fast~~ → codex 无此参数，已删（见 .plans/decisions.md）
  - 权限 → 固定 `approvalPolicy:"never"` + `sandbox:"danger-full-access"`（= dangerously bypass）→ 无 mid-turn 审批
  - 图片 → input `{ type:"local_image", path }`
- **传输层**：`@larksuiteoapi/node-sdk` 长连接（WSClient）收 `im.message.receive_v1` + `card.action.trigger`(卡片回调) + `application.bot.menu_v6`(菜单)。lark-cli **收不到卡片回调**，仅用于出站动作（发卡/置顶/建群/reply_in_thread）+ OAuth onboarding。

---

## 5. 访问控制

| 列表 | 含义 | 默认 |
|---|---|---|
| `admins` (open_id) | 能**私聊 bot** = 建项目 / 全局配置 / 破坏性操作 | **只有 owner**（onboarding 扫码者） |
| `allowedUsers` (open_id) | 能在**群+话题** @bot 干活 | 空 = 不限制 |
| `allowedChats` (chat_id) | bot 在哪些群响应（功能同 reference） | 空 = 不限制 |

- 破坏性操作（删项目、杀别人的 run）限 admins。
- 编辑入口：私聊 `/config`（⚙️ 设置）访问控制卡。

---

## 6. 稳定性（重做的核心动机）

**"卡住"症状**：turn 卡在"✍️ 正在输出…"不动，期间发新消息无响应。

- **per-turn idle watchdog**（全局配置，**默认 120 秒、默认开启、可在设置改**）：turn 距上次 app-server 事件超过阈值 → 判假死 → `turn/interrupt`，不行 SIGKILL 子进程 → 卡片标 **"⏱ 已中止，可重试"**（不自动重试，避免重复副作用）。
- **运行中发新消息行为**（全局配置，**默认 引导 steer**）：
  - 当前无 turn → 开新 turn
  - turn 健康 → `turn/steer` 注入（或排队 queue，按设置）
  - turn 已判假死 → 中止死 turn + 用新消息开新 turn（自动解卡）
- **连接层**：长连接心跳 + 自动重连；`🔄 重连` 兜底。
- **进程回收**：会话结束/超时回收 app-server 子进程；启动清理孤儿。
- **并发上限** `maxConcurrentRuns` 默认 10，超出 FIFO 排队。

---

## 7. 命令 → 卡片/菜单 映射（斜杠基本清零）

| 原命令 | 替代 |
|---|---|
| `/new project` | DM 机器人菜单「➕ 新建项目」 |
| `/projects` `/rm` | DM 菜单「📁 项目列表」+ 列表卡删除按钮 |
| `/config` | DM 菜单「⚙️ 设置」 |
| `/doctor` | DM 菜单「🩺 诊断」 |
| `/help` | DM 自由文本 → 引导卡 |
| `/model` `/effort` | 话题运行卡「⚙️ 设置」下拉（codex 无 fast） |
| `/stop` | 运行卡「⏹ 中止」按钮 |
| `/new` `/reset` `/status` | 回群开新话题 / 置顶横幅 / 运行卡 |
| `/resume` | 配置卡「🔁 恢复历史会话」 |
| `/reconnect` | DM 菜单「🔄 重连」 |

残留斜杠：基本无（`/reconnect` 已菜单化）。

---

## 8. 技术栈与复用

- **语言/运行时**：TypeScript + Node ≥ 20。
- **直接复用 references 的成熟模块**（外观沿用，按 app-server 事件重写映射层）：
  流式卡片渲染（run-renderer / run-state / tool-render / text-renderer）、消息回复方式(card/markdown/text)、工具调用显示(show/hide)、media 缓存(图片/文件)、session 持久化思路、keystore、config store。
- **数据目录** `~/.feishu-codex-bridge/`，**包名/命令名** `feishu-codex-bridge`。
- **后台服务**：先 macOS `launchd`（复用 service-adapter 抽象）；**未来加 Windows** 为增量。
- **CLI 私有安装**：缺 codex / lark-cli 时装到 `~/.feishu-codex-bridge/{codex-cli,lark-cli}`；codex 也查 `CODEX_BIN`/PATH/`Codex.app`。
- **onboarding**：找 codex CLI → 检查 codex login → 扫码建飞书应用 → 存 keystore → 装/初始化 lark-cli（同一 App ID）→ 后台配置机器人自定义菜单（文档指引）。

---

## 9. 开放平台配置（onboarding 文档需覆盖）

- 权限 scope（**全用细分名**——飞书新应用已把 `im:chat`/`im:message` 等合并 scope 拆开、合并名不可单独开通，用合并名会导致一键链接开不了 + 检测误报）：`im:message.group_at_msg:readonly`(@bot 消息) `im:message.p2p_msg:readonly`(私聊) `im:message:send_as_bot`(发卡/回话题) `im:resource`(上传资源) `im:chat:create`(建群) `im:chat:update`(**转让群主** owner_id) `im:chat.announcement:read`+`im:chat.announcement:write_only`(群公告 docx block 读=list/写=create+delete) `im:chat.top_notice:write_only`(**置顶群公告** put_top_notice action_type=2) `cardkit:card:write`(交互卡片)；可选 `drive:drive`(云文档评论)。**权威清单 = `src/config/scopes.ts` `REQUIRED_SCOPES`。** 飞书无「扫码即授权」接口（`registerApp`/官方 larksuite-cli 均无 scope 参数），故 `start` 用 tenant token 调 `application/v6/scopes` 检测缺失，缺则打印含全部权限的一键开通链接 `…/app/<id>/auth?q=<逗号分隔>`，用户点一次全开（即时生效，无需重启）。**不需要 `im:chat:delete`**——删项目时 bot 不主动解散，而是**把群主转让给 admin**（用 `im:chat`，与建群同款），由 admin 自行解散（bot 是群主、用户无法自行解散，见 §3.1 + decisions.md 2026-05-26）。
- 事件（长连接）：`im.message.receive_v1` `card.action.trigger` `application.bot.menu_v6`；可选 `im.message.reaction.*` `im.chat.member.bot.added_v1`
- 机器人自定义菜单：后台「机器人能力 → 机器人自定义菜单」配置 5 项（推送事件，各设 event_key），发布版本生效。

---

## 10. 开放项验证状态

**✅ 已验证（codex app-server，本机 codex 0.131.0，零 token 成本）** —— 详见 `prototype/appserver-probe/FINDINGS.md`
- 握手 `initialize`/`initialized`、线协议 = JSONL JSON-RPC 2.0、服务端通知经 stdout 回传。
- 方法全表存在：`thread/start` `thread/resume` `turn/start` `turn/steer` `turn/interrupt` `model/list` 等。
- 参数对齐：thread/start 带 model/cwd/approvalPolicy/sandbox；**turn/start 可按 turn 覆盖 model/effort/sandbox/approval 且沿用后续 turn**（= 话题内改设置改下一轮）；turn/steer 需 `expectedTurnId`；turn/interrupt 需 `threadId+turnId`。
- 枚举：effort `none|minimal|low|medium|high|xhigh`；sandbox `read-only|workspace-write|danger-full-access`；approval `untrusted|on-failure|on-request|never`。
- `model/list` 返回每模型 `supportedReasoningEfforts` → 配置卡 effort 选项可随模型联动。

**✅ 已验证（飞书侧，用现有应用 `cli_aa81b50143785cd9` 实跑）**
- `im +chat-create --as bot`：建群、拉人、返回 chat_id + share_link ✓
- **`reply_in_thread` 建话题**：对根消息做 `+messages-reply --reply-in-thread` → 生成 `thread_id`(omt_xxx)，`root_id/parent_id` 指向根消息。**普通群(group) 和话题群(topic) 都成立** → 项目群用普通群即可（主区普通聊 + @消息派生话题）。注意：lark-cli reply 响应不透出 thread_id，需从消息(`GET /im/v1/messages/:id`)或 receive 事件取。
- `im pins create --as bot`：置顶消息成功 ✓（群横幅可行）。
- 发现：缺 `im:chat:delete` scope，bot 无法解散群（99991672）。**初版决策"群由用户自行解散"已作废**——群是 bot 建的、bot 是群主，用户只能退群、无法解散。→ **修正决策（2026-05-26）：删项目时 bot 把群主 `chat.update owner_id` 转让给 admin（用 `im:chat`），由 admin 自行解散；另设 DM「🚪群管理」转让遗留群。见 decisions.md。**

**⏳ 待验证**
- 真实 `turn/start`+`turn/steer`+`turn/interrupt` 全链路（需模型请求耗 token；schema 已确认、yepanywhere 生产在用，风险低）。
- **长连接事件接收**：`im.message.receive_v1`(带 thread_id) + `card.action.trigger` + `application.bot.menu_v6` —— 需 node-sdk WSClient（拿 appSecret）+ 该应用在后台**订阅这些事件(长连接模式)** + 配好机器人菜单。这是实现的第一片，非纯验证。
- 群置顶横幅在话题视图不可见（已知，由运行卡兜底）。

---

## 决策映射（grill 编号）

Q1 目标 · Q2 范围 · Q3/Q6 模型与三层默认 · Q4/Q10 配置卡字段与 codex 映射 · Q7 分支只读 · Q8 置顶横幅 · Q9 TS/Node+node-sdk · Q11 resume(仅新建时) · Q12 app-server 后端 · Q13 审批(因固定 dangerous 消解) · Q14/Q15 访问控制 · Q16 项目生命周期 · Q17 DM 使用向导(混合C) · Q18 watchdog/steer/卡死处理 · Q19 仅 macOS · Q20 命令卡片化 · UI 纠偏：话题无头部卡、设置挂最新卡、卡片按钮即菜单。
