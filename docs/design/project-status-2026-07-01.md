# feishu-codex-bridge 项目现状（2026-07-01 · 以代码为准重新梳理）

> 本文由通读 `src/` 全量源码（13 个模块簇，约 2.95 万行，另有 527 个 codex 协议自动生成文件）+ `git log` 重新梳理而成，**以代码实际实现为准**。`docs/design/feishu-codex-bridge-design.md` / `implementation-plan.md` 是 v1（codex-only、仅 macOS）时代的设计稿，其「非目标」章节多数已被后续版本实现（双后端、多平台服务、Web 控制台、反向桥、文档评论、多机器人、三档沙箱），阅读旧稿时请对照本文。
>
> 用途：社区反馈评估 loop 判断「某条反馈与本项目的关系」时，对照本文第 4 节「能力清单」与第 5 节「边界/非目标/已知缺口」。评估口径见 `scratchpad/rubric.md`。
>
> 版本基线：`@modelzen/feishu-codex-bridge` v0.6.4（package.json）。

---

## 1. 一句话定位

把飞书 / Lark 消息桥接到**本机**的编码 agent（Codex app-server 或 Claude Agent SDK），在群里 @ 机器人就让它在指定项目目录里干活，结果以流式 Markdown 卡片实时回到群里；另有一条反向桥（☕ 咖啡一下）把本机 CLI agent 的审批/提问/完成接管到飞书私聊。它是**给个人与信任小团队自用的桥，不是多租户托管服务**。

## 2. 交互模型（核心心智）

- **项目 = 群 = 固定 cwd**：一个飞书群绑定一个本地目录，建项目时确定、群内不可改。
- **话题(thread) = 会话(session)**：每个飞书话题对应一个后端 agent 会话；话题内消息 = 该会话的一轮 turn。
- **两种群**：`multi`（多话题群，每话题独立会话、可并行）/ `single`（单会话群，整群一条连续会话、全程免@）。`project.kind` 选择。
- **三层默认逐层覆盖**：全局默认（config）→ 项目默认（建项目时）→ 话题/运行卡（逐项覆盖）。
- **三大交互面**：私聊（管理控制台 + 使用向导，永不跑项目任务）/ 项目群主区（@bot 弹配置卡）/ 话题（= 会话，运行卡带 ⏹/⚙️ 控件）。
- **后端「创建时选定、运行时固定、不支持切换」**：`project.backend` 只影响新话题；进行中会话记在 `SessionRecord.backend` 上不变。

## 3. 模块地图（`src/`）

| 目录 | 职责 |
|---|---|
| `cli/` + `core/` + `platform/` + `index.ts` | CLI 命令面与进程运行时脊柱：run/start/stop/restart/status/logs/update/web/bot/doctor + 隐藏 secrets/hook/__daemon-control；结构化日志、单实例锁、跨平台 spawn/进程组 kill、版本解析。 |
| `config/` + `utils/{feishu-auth,event-diagnosis,open-url}` | 落盘与身份地基：AppConfig schema + 归一化偏好读取、多机器人注册表、路径布局、AES-256-GCM 密钥库、SecretRef 解析、飞书 scope 清单 + 一键授权链接、凭据校验 + 已授 scope 对比、只读事件订阅诊断。 |
| `agent/`（顶层） | 后端无关抽象层：`AgentBackend/AgentThread/AgentEvent` 契约、后端 CATALOG、懒注册表、运行时探测 + 智能默认后端、按需 npm 依赖装/卸/回滚工具链、用量门面、注入每个会话的桥开发者指令。 |
| `agent/codex-appserver/` | Codex 后端（默认、能力最全）：驱动 `codex app-server` 子进程（JSON-RPC/stdio），线程生命周期、流式/自主目标 turn、三档 OS 沙箱、模型发现、常驻进程池、ChatGPT 账号用量数据层。 |
| `agent/claude-agent/` | Claude Agent SDK 后端：进程内 `query()` 常驻会话、三档 OS 沙箱、settingSources 加载 CLAUDE.md/skills、合成 /goal、原生 /compact、双向 /resume（读 `~/.claude/projects`）。 |
| `bot/handle-message.ts`（4255 行核心） | 中央编排器：所有活跃运行态 + 把每个入站飞书信号接到 agent；斜杠命令、卡片回调、运行/目标循环、会话解析/驱逐/回收、DM 管理控制台。 |
| `bot/{bridge,supervisor,watchdog,session-store,register-bot}` | 进程/运行时骨架：长连接启动、多机器人「一 bot 一进程」监督器、per-turn idle watchdog + 优雅中断 + FIFO 并发信号量、会话持久化、扫码凭据校验与落盘。 |
| `bot/{comments,context-weave,dm-console,media,onboarding,wizard,card-content}` | bot「边缘」：云文档评论流、入站上下文编织（引用/话题上文/图片/文件/降级卡）、DM 控制台入口、多模态下载、扫码 onboarding、卡片正文恢复。 |
| `card/` | 表现与卡片传输层：schema 2.0 卡片构造器、CardKit 流式打字机、AgentEvent→RunState reducer、卡片回调路由、出站图片/feishu-card fence 渲染。 |
| `cli-bridge/` | ☕ 咖啡一下反向桥：本机 Claude/Codex 的 hook（审批/提问/Stop）经 IPC 转发到飞书私聊；presence 离开检测、keep-awake、续聊、hook 安装/修复。 |
| `project/` | 项目抽象：createProject/joinExistingGroup、projects.json 注册表、git 分支检测、群主转让/自离群、群公告横幅 + 惰性分支刷新、群 onboarding。 |
| `web/` + `admin/` | 127.0.0.1 本地 Web 控制台 + 共享 admin service 层（读=直读文件、写=按进程形态注入，与 DM 卡片同源 `admin/ops.ts`）。 |
| `service/` | 跨平台后台服务抽象：launchd（macOS）/ systemd（Linux·WSL）/ HKCU Run（Windows）三后端 + 自更新。 |

---

## 4. 已支持能力清单（判定「本项目已支持」时对照）

> 状态标记：✅ 完整支持 · 🟡 支持但有文档化缺口/限制 · 🧩 声明占位未接后端（下称「占位」）。绝大多数能力为 ✅。

### A. Agent 后端
- ✅ **双后端**：Codex app-server（默认 `codex-appserver`，能力最全）+ Claude Agent SDK（`claude-agent`），同机可混用；建项目/绑群时按需选。
- ✅ **后端无关抽象**：统一 `AgentBackend/AgentThread/AgentEvent` 契约，上层不感知具体协议；能力位（goal/steer/compact/resume/approvals）驱动 UI 裁剪。
- ✅ **Codex 独有**：真·自主目标引擎（thread/goal，N 轮自续）、飞行中 steer（turn/steer）、常驻进程池（冷启动 ~2.1s→~64ms）、ChatGPT 账号用量/限额数据。
- ✅ **Claude 独有**：settingSources 加载项目/用户 CLAUDE.md + skills + `.claude/settings.json`、原生 `/compact` 斜杠、与 `claude -r` 双向可见的会话存储。
- ✅ **模型发现**：Codex 动态 `model/list`（带静态兜底 gpt-5.5）；Claude 静态 3 模型（opus-4-8 默认 / sonnet-4-6 / haiku-4-5）。effort 随模型 supportedEfforts 联动。
- ✅ **Claude SDK 按需下载**（~265MB，随桥硬依赖但懒加载）；通用按需 npm 依赖装/卸/回滚工具链（当前内置后端未实际使用）。

### B. 会话与运行
- ✅ **流式运行卡**：CardKit 逐字打字机（答案元素）+ 整卡更新（推理/工具/按钮），每 chat ~4QPS 限速 + 429 退避 + streaming_mode 10 分钟自动重启。
- ✅ **⏹ 优雅中断**（按钮 + OK/DONE 表情）：turn/interrupt 后线程/进程保活复用；仅 turnId 未拿到 / 5s 排空超时才 SIGKILL。
- ✅ **steer / queue**：运行中来新消息，健康 turn 走 steer 注入（Codex）或排队（`pendingPolicy`，Claude 恒排队）。
- ✅ **per-turn idle watchdog**（默认 120s，可配 0=关）：超时且后端活动时钟也停 → 中止 + 回收进程；长命令经 lastActivity 重臂不误杀。
- ✅ **全局并发上限**（`maxConcurrentRuns` 默认 10，1..50）：满则 FIFO 排队卡（第 N 位 + ⏹取消，位置实时刷新）。
- ✅ **会话解析三态**：LIVE 复用 / resume 恢复 / recreate 新建重指；重启后惰性 resume。
- ✅ **闲置会话回收**：>45min LIVE 线程回收（SIGKILL 子进程止 ~172MB/进程泄漏），持久记录留存下次无缝 resume。
- ✅ **持久会话存储**：话题↔后端线程绑定（含 model/effort/backend override）跨重启，原子写 + 进程内锁 + v1→v2 迁移。
- ✅ **admin/guest 权限分档**：guestMode 不同则会话 key 加 `#admin`/`#guest` 后缀，来宾不共享管理员线程沙箱/历史。

### C. 斜杠命令（能力自适应裁剪，后端不支持则不显示）
- ✅ `/goal <目标>`：自主多轮干到完成；运行卡带 ⏹终止 + 🎯 结束目标（本轮跑完停）。Codex=N 卡真状态机；Claude=1 自主轮 + 合成状态（🟡 无 paused/usageLimited、无 token 预算）。
- ✅ `/model`：模型 + effort 选择器，仅路由本会话/项目后端，下一轮生效。
- ✅ `/resume`：历史会话选择器（owner/admin），折叠历史卡 + 惰性续。
- ✅ `/compact`：手动上下文压缩（动画卡 + 旧%→新%）。
- ✅ `/context`：上下文窗口用量表（70/85/95% 分档）。
- ✅ `/help`：按 scope（single/topic/main）+ 后端能力 + admin 裁剪的速查卡。
- ✅ `/settings`：群内项目设置卡（免@ / 自动压缩 / 默认模型强度，admin only）。
- ✅ `/usage`：Codex 账号 5h/7d 限额 + 个人统计 + 可转发战绩分享卡（仅 ChatGPT 登录）。
- ✅ **零输入表情控制（M-6）**：运行卡上 OK/DONE=停、终态卡 👍=续轮（合成「继续」重跑全流程）。

### D. 权限与沙箱
- ✅ **三档权限**：🔒 只读(qa) / ✏️ 读写(write) / ⚠️ 完全(full)，per-project 可设，另有 guestMode 分档。
- ✅ **OS 级沙箱强制**：Codex=自定义 `feishu` permissions profile → macOS Seatbelt / Windows 受限令牌；Claude=SDK sandbox → macOS Seatbelt / Linux bubblewrap。始终 `approvalPolicy:never`，沙箱是唯一安全闸门。
- ✅ **fail-closed 不静默降级**：qa/write 在不支持的平台一律**启动前**抛错拒绝，绝不降级为完全访问。
- ✅ **网络开关**：qa/write 项目可设 network 开/关（full 恒联网）。
- ✅ **权限变更即时生效**：改 tier/network/autoCompact 时驱逐该群 LIVE 线程，下一轮 resume 重绑沙箱。

### E. 项目 / 群生命周期
- ✅ **建项目**：私聊建空白项目（git init）或绑现有目录 → bot 建群、拉人、设群管理员、写群公告横幅、onboarding；重名/路径不存在在建群前就报错（无孤儿群）。
- ✅ **绑存量群**：bot 被拉进群 → DM 拉人者绑定卡 → joinExistingGroup（默认 qa 只读、不建群不改群主）。
- ✅ **删项目**：解绑 + 群主转让给 admin（created）/ bot 自离群（joined）→ 请人自行解散；bot 绝不主动解散、绝不删代码目录。
- ✅ **群公告横幅**：docx block 写「📁名·📂路径·🌿分支」+ 置顶；分支惰性检测（变了才重写）。
- ✅ **群 onboarding**：欢迎卡 + Pin + 「👈使用说明」chat tab + 群菜单入口（created 群；按后端裁剪命令）。
- ✅ **bot 加/退群生命周期**：被拉进群推绑定卡；被移出群自动解绑并通知。

### F. 卡片与 UI
- ✅ **CardKit 2.0 流式传输**：点击可变 + 流式文本的唯一正确面；per-render token 破 SDK 12h 回调去重；处理 200610/200810/230099/300305/300309/300317/429 等飞书错误码。
- ✅ **运行卡运行态/终态两套布局**：推理面板 + 工具面板（≥3 折叠）+ 单答案元素 + 状态脚注 + 模型·effort 脚注（色分档）+ gauge + 控件；终态折叠过程、突出最终答案、错误建议（纯文案不发请求）。
- ✅ **DM 管理控制台卡**：菜单 / 新建项目·绑群表单 / 项目列表（分页 8/页）/ 话题下钻 / 删除确认 / 全局设置 / ☕子卡 / 📝评论设置 + 提示词编辑 / watchdog / 诊断 / 重连 / 更新 / 管理员·允许名单 / 权限档 / 默认模型。
- ✅ **出站富文本**：markdown 图片先上传（限 cwd 子树内，防外泄）再内联；```feishu-card fence → 独立干净卡。
- ✅ **诊断卡**：codex/连接/版本自检 + 三态 scope 诊断 + 事件订阅诊断 + 可粘贴给 codex 的自检 prompt。

### G. 多模态与上下文编织
- ✅ **入站图片**：下载为 localImage 交给 agent（≤9 张，含 merge_forward 尽力恢复）。
- ✅ **入站文件附件**：下载到本地、以「名→绝对路径」清单织入 prompt（≤9 个、≤50MB；🟡 仅 full 档可读，因在 cwd 外）。
- ✅ **引用消息 / 话题上文 / 发信人身份**编织进 turn；单一 sanitize 边界防提示注入。
- ✅ **降级交互卡正文恢复**：`raw_card_content` 取回真实正文（如 Base 记录链接）。

### H. 云文档评论 @bot 流
- ✅ **评论 @bot → 跑 agent → 回评论线程**：支持 doc/docx/sheet/bitable（含 wiki 节点解析）；per-doc cwd、per-comment-thread 会话、串级 withDocLock、共享全局信号量。
- ✅ **可编辑提示词**：master 文件同步为 per-doc AGENTS.md（codex）+ CLAUDE.md（claude）；全局提示词编辑器改后 fan-out 重同步到所有历史文档目录。
- ✅ **Typing 表情回执 + markdown 剥离 + 2000 字截断**；🟡 整文档评论回复兜底仅 doc/docx。仅管理员可用；不可中断（idle watchdog 是唯一开关）。

### I. ☕ 咖啡一下（反向桥）
- ✅ **本机 CLI hook → 飞书私聊**：PermissionRequest 审批卡（允许/始终允许/拒绝）、AskUserQuestion 结构化表单（Claude only）、Stop/完成卡 + **续聊**（回复继续，多轮）。
- ✅ **presence 离开检测**（macOS ioreg + 锁屏即离开；🟡 Windows 实验性未验；Linux 无 idle 读取器→实际不转发）；`away_only` 路由；notify-scope（all/bound_projects/none）。
- ✅ **keep-awake**（macOS caffeinate，等待期间不休眠）；本机回归即接管；会话级 allow 缓存；hook 安装/检查/修复/agent2lark 冲突检测。
- ✅ **自环防护**：桥自己起的会话（`FEISHU_CODEX_BRIDGE=1`）不自转发。

### J. Web 控制台（127.0.0.1）
- ✅ **本地控制台**：仅绑 127.0.0.1 + token（Bearer/cookie/?token=）+ Host/Origin 防 DNS rebinding；扫码加机器人（扫码人自动成为 owner/admin）、项目设置读写、诊断、后端装卸、daemon 生命周期、日志实时 tail(SSE)。
- ✅ **Web=DM 卡片写操作同源**（`admin/ops.ts`，零漂移）；无 daemon 时退化只读预览（写→501，仅允许启 daemon/更新）。
- ✅ **稳定 URL**：canonical 端口 51847 + 稳定 token + discovery 文件跨重启存活。

### K. 多机器人与后台服务
- ✅ **多机器人**：一机注册多 bot、可同时连接（≥2 走 supervisor「一 bot 一进程」+ 指数退避重启 + IPC 聚合 Web 控制台）。
- ✅ **跨平台后台服务**：macOS launchd（开机+崩溃自启）/ Linux·WSL systemd / Windows HKCU Run（🟡 登录自启、无崩溃自拉起）；`start/stop/restart/status/logs`。
- ✅ **自更新**：`update [--check]`（npm i -g @latest + 重启 daemon；dev 检出拒绝改走 git pull）。

### L. 配置与安全
- ✅ **AES-256-GCM 密钥库**：App Secret 存 secrets.enc（PBKDF2 host+user+salt），配置里只存 exec SecretRef，明文绝不落 config/日志。
- ✅ **SecretRef 解析**：plain / `${ENV}` / env|file|exec provider（自桥短路直读密钥库）。
- ✅ **访问控制**：owner（扫码者，永久 admin）/ admins（能私聊建项目 + 破坏性操作）/ 项目级 allowedUsers / allowedChats。
- ✅ **归一化偏好**：messageReply/showToolCalls/showModel/maxConcurrentRuns/requireMentionInGroup/pendingPolicy/agentStopGraceMs/runIdleTimeout 等（存值=生效值）。

### M. Onboarding / 自检
- ✅ **扫码建飞书应用**（wizard registerApp，CLI ASCII QR + Web SSE 双路），扫码者设为 owner+admin。
- ✅ **一键 scope 授权链接**（15 个必需细分 scope + 可选组），凭据校验 + 已授 scope 对比。
- ✅ **只读事件订阅诊断**（4 态 ok/missing/unpublished/unchecked）+ 上线后轮询「事件已生效」通告。
- ✅ **doctor**：后端/登录/lark-cli/配置/事件订阅自检。

---

## 5. 明确边界 / 非目标 / 已知缺口（判定「无关」或「已知不做」时对照）

### 5.1 产品定位边界
- **不是多租户托管服务**：给个人 + 信任小团队自用；⚠️完全访问档 = 任何能给 bot 发消息的人都能以你身份在本机执行任意命令。
- **后端运行时不可切换**（已移除的非目标）：创建时选定、运行时固定；改后端须删项目重建。防御仍在（`performBackendSwitch` 已设值即拒）。
- **飞书唯一群主**：bot 建群即群主，靠把创建者提为 admin 分权；解散/转让/管管理员限 bot。删项目不主动解散（省 `im:chat:delete`）。

### 5.2 沙箱/平台边界（fail-closed）
- **qa/write 隐私档仅 macOS + Windows（Codex）/ macOS + Linux（Claude）**；其它平台**启动前抛错拒绝**，绝不静默降级为 full。
- **Linux·WSL 读写档**：Codex 沙箱只挡写、读仍开放（Landlock 读限未实现）→ 故 qa/write 在 Linux 直接 fail-closed。
- **Windows 沙箱强制是 codex 的、未在真机对不可信外部群验证**（代码注释明示，用前需验）。
- **🟡 已知缺口：Claude qa 档「读」未硬限在 cwd**（codex qa 在 mac/win 连读也锁）——Read/Bash 读仍可越界；外部群「连读也不外泄」暂以 Codex 为准。
- **🟡 Claude qa/write 的 Bash 网络隔离是尽力而非硬闸**（需硬隔离网络前先验）。

### 5.3 飞书平台固有限制
- **长连接必需**：card.action.trigger / bot menu 只有 node-sdk WSClient 长连接能收，lark-cli 收不到（lark-cli 仅用于出站 + onboarding）。
- **无 scope/事件写 API**：飞书没有「扫码即授权」或「API 订阅事件」接口 → scope 靠一键链接手点、事件订阅靠 deep-link 手填 + 轮询检测；callback 配置（card.action.trigger）根本无法检测，只能手工指引。
- **免@需 `im:message.group_msg` scope**；表情驱动需 `im:message.reactions:read`（缺则静默关）；这些可选 scope 缺失只降级对应功能、绝不阻塞启动。
- **卡片组件/体积上限**：~200 组件超了整卡静默丢弃(300305)→项目列表分页 8/页、话题上限 50；~30KB/元素→历史 18KB、工具正文 2500 截断。
- **输入框长度 1..1000**：🟡 评论提示词编辑上限 1000 字，更长须编辑 master 文件（已知缺口）。

### 5.4 功能边界
- **私聊只做管理 + 引导，永不跑项目任务**。
- **云文档评论**：仅管理员可用（可改文档，破坏性）；不可中断；整文档评论回复仅 doc/docx；不支持云盘 file/slides/mindnote；合并转发子消息的文件永不下载。
- **/goal 无总时长上限**（健康目标可跑数天），唯一自动兜底是 30min idle watchdog；goal 会话不接外部输入（turns 自续，不排队）。
- **☕反向桥**：仅装 PermissionRequest + Stop 两类 hook（PreToolUse/PostToolUse 有解析无安装）；Codex 的 AskUserQuestion 不做结构化卡（源码锁在 Plan 模式）→ 只走完成卡文本 + 回复；`delivery` 恒 `away_only`（历史死字段）；keep-awake/presence 深度依赖 macOS，Windows 未验、Linux 实际不转发；主开关须先设 bot owner。
- **入站文件在项目 cwd 外**（全局 inboundDir）→ 只有 full 档 agent 能读；文件对 codex 只是路径清单、无原生文件输入。
- **大群只取成员首页 100**：更大群需手填 open_id（allowlist/管理员卡）。
- **姓名解析**需 `contact:user.base:readonly`，否则卡片显示 open_id 尾号（外部跨租户群普遍如此）。

### 5.5 占位/未接（🧩）
- **工具审批转发到卡片（approval_request）**：事件类型 + approvals 能力位是**前置占位**；Codex 恒 `never` 不发审批、Claude 声明 approvals:false，**当前无任何后端真正吐审批**。这是「未来审批转发切片」的预留。

---

## 6. 平台能力矩阵

| 能力 | macOS | Windows(原生) | Linux / WSL |
|---|---|---|---|
| 后台服务 | launchd（开机+崩溃自启） | HKCU Run（登录自启，🟡无崩溃自拉起） | systemd（🟡需 `loginctl enable-linger` 保活；WSL 需 `systemd=true`） |
| qa/write 沙箱(Codex) | ✅ Seatbelt | ✅ 受限令牌（未真机验外部群） | ❌ fail-closed 拒启 |
| qa/write 沙箱(Claude) | ✅ Seatbelt | ❌（无 Windows 沙箱路径） | ✅ bubblewrap |
| ☕ keep-awake / presence | ✅ caffeinate + ioreg | 🟡 实验未验 | ❌ 无 idle 读取器→不转发 |

不支持后台服务的平台：`getServiceAdapter()` 硬抛错，前台 `run` 是通用兜底。

## 7. 技术栈事实

- **语言/运行时**：TypeScript + Node ≥ 20，ESM，tsup 打包（dist/cli.js + dist/index.js）。
- **依赖**：`@larksuiteoapi/node-sdk`（长连接 WSClient）、commander、cross-spawn、qrcode-terminal；devDep 含 `@anthropic-ai/claude-agent-sdk`（external，按需下载）、vitest。
- **数据目录**：`~/.feishu-codex-bridge/`（bots.json 注册表、per-bot config/projects/sessions、secrets.enc 密钥库、logs、web-console.json、media/inbound、comments、cli-bridge socket）。
- **测试**：83 个测试文件（vitest），含纯函数单测 + 少量 LIVE 集成（真实计费，需 `CLAUDE_LIVE=1`）。
- **codex 协议绑定**：`codex app-server generate-ts` 产物入库（`agent/codex-appserver/protocol/generated/`，527 文件，勿手改，`npm run codex:protocol:update` 重生成）。

---

*本文快照于 2026-07-01，基于 git `f73b6a9`(v0.6.4)。所有能力/边界均有 `src/**` file:line 佐证（见评估过程 scratchpad/maps.json）。*
