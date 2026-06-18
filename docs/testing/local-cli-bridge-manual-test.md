# 手动测试手册 · 本地 CLI agent 桥接（锁屏离开 / 离开保活 / 通知范围）

一条贯穿全部功能的端到端用例 + 操作手册。覆盖：飞书接管开关、通知范围三档、按后端开关、
离开保活（caffeinate）、锁屏/空闲离开判定、回到本机收回、权限卡 / 选择卡 / 完成卡续聊、
本会话放行缓存、多机器人不重复装 hooks。

> 仅 macOS。Windows 离开检测为实验性，不在本手册范围。

---

## 0. 你需要准备什么（硬前置）

1. **一台 Mac**：跑这份分支的守护进程 + 在终端里跑 `claude` / `codex`。
2. **一部手机，装飞书，登录 = 机器人 owner 的同一个账号**。
   - ⚠️ **必须用手机（或第二台设备）操作卡片**。原因：触发“离开”最干净的方式是**锁屏**，锁屏后你
     看不到 Mac 桌面；而且只要你在**这台 Mac** 上动鼠标/键盘，就会被判成“回到本机”，正在等待的
     卡片会被立刻收回。所以「Mac 跑活 + 手机点卡片」既是真实用法，也是唯一干净的测法。
3. 本机已装 **Claude Code**（`claude`）和 **Codex**（`codex`），且 Claude Code 处于**默认会问权限**的模式
   （不要开 `--dangerously-skip-permissions` / 自动接受，否则不会触发权限卡）。
4. 机器人已设好 **owner**（你扫码注册的那个）。设置卡若显示「启用本地 agent 前请先设置机器人 owner」
   说明没 owner，先去解决。

### 路径速查

| 东西 | 位置 |
|---|---|
| 数据目录 | `~/.feishu-codex-bridge/` |
| 单 bot 配置 | `~/.feishu-codex-bridge/bots/<appId>/config.json` |
| 守护日志 | `~/.feishu-codex-bridge/logs/YYYY-MM-DD.log` |
| Claude 钩子 | `~/.claude/settings.json`（`.hooks`） |
| Codex 钩子 | `~/.codex/hooks.json` + `~/.codex/config.toml`（`[features] hooks=true`） |

---

## 1. 让 hooks 指向“这份分支”的代码（关键）

「修复 hooks」写入的 hook 命令内嵌**当前正在运行的脚本路径**。所以要测这份分支，必须用这份分支的
构建产物跑守护进程，再点「修复 hooks」。

```bash
# 在本 worktree 根目录
npm run build                      # tsup 产出 dist + bin

# 先停掉任何其它在跑的 feishu-codex-bridge（同一个 bot），避免抢 socket / 抢 hook
#   pgrep -fl feishu-codex-bridge   # 看有没有别的实例
#   然后停掉它

# 用这份分支的 bin 起守护进程（保持这个终端开着）
node bin/feishu-codex-bridge.mjs run
```

随后在**手机飞书**私聊机器人 → 打开「⚙️ 设置」→ 找到「🖥️ 本地 agent」：

1. 把「飞书接管本地 agent」开成 **开**。
2. 点 **修复 hooks**。
3. 看到 `Claude Code：已安装`、`Codex：已安装`。

**验证 hooks 指向本分支**（应能看到本 worktree 的路径）：

```bash
jq '.hooks' ~/.claude/settings.json     # command 里应含本 worktree 的 bin 路径 + "--agent claude --bot <appId>"
cat ~/.codex/hooks.json
grep -A2 '\[features\]' ~/.codex/config.toml   # 应有 hooks = true
```

---

## 2. 三个观测窗口（开始测之前都开好）

**窗口 A — 守护日志**：

```bash
tail -f ~/.feishu-codex-bridge/logs/$(date +%F).log
```

**窗口 B — caffeinate 观测器**（必须在**锁屏前**就启动，它会一直写文件，锁屏期间照常记录）：

```bash
( while true; do
    d=$(date +%H:%M:%S); p=$(pgrep -x caffeinate)
    if [ -n "$p" ]; then echo "$d  caffeinate RUNNING: $(ps -o args= -p $p | tr '\n' '|')"
    else echo "$d  caffeinate none"; fi
    sleep 2
  done ) | tee /tmp/caffeinate-watch.log
```
> 期望：保活生效时这里出现 `/usr/bin/caffeinate -i -w <pid>`。注意是 **`-i` 不是 `-d`**
> —— `-i` 只防系统休眠，屏幕照样能熄灭；若看到 `-d` 就是 bug。

**窗口 C — 跑 agent 的终端**（在不同目录里分别跑，用于测通知范围）。

**随手验证锁屏判定**（可选）：

```bash
ioreg -n Root -d1 -k IOConsoleUsers | grep CGSSessionScreenIsLocked   # 锁屏时出现 = Yes
```

---

## 3. 主用例：一条贯穿全部功能的脚本化场景

> 通用动作：**“锁屏”= `⌃⌘Q`（Control+Command+Q）**；**“回到本机”= 解锁（输密码/指纹）**。
> 触发卡片的标准节奏：在窗口 C 敲下 prompt 回车后**立刻 `⌃⌘Q` 锁屏**，让 agent 在“离开”状态下命中钩子。

### Phase 1 — 设置卡 UI（不需要离开，全程在手机上点）

在手机飞书设置卡的「🖥️ 本地 agent」里逐项点，每点一次卡片应**原地刷新、当前值高亮**：

- [ ] **通知范围**：`全部` / `仅绑定项目` / `不通知` 三颗按钮，点谁谁变主色（高亮）。先停在 **全部**。
- [ ] **转发哪些后端**：`Claude Code：开/关`、`Codex：开/关` 各自独立切换，互不影响。两个都留 **开**。
- [ ] **离开保活**：默认 **开**；点一下能切到关、再点回开。留 **开**。
- [ ] 卡片底部应有一行：`hooks 为本机全局，多个机器人共用一套（修复不会重复安装）`。

✅ 证明：四个维度独立、即时生效、UI 高亮正确。

### Phase 2 — 离开 + 权限卡 + 离开保活（核心）

1. 窗口 C：`cd ~/somewhere` 后 `claude`，输入：`运行 shell 命令 echo hello-from-claude`，回车。
2. **立刻 `⌃⌘Q` 锁屏。**
3. 手机飞书应收到一张 **「Claude Code permission」审批卡**（含命令 `echo hello-from-claude`、工作目录）。
4. 此时**先别操作**，等 3~5 秒 → 窗口 B 的 caffeinate 观测应记录到 `caffeinate RUNNING: ... -i -w ...`。
5. 手机上点 **✅ 允许**。卡片变「✅ 已允许」。
6. 解锁 Mac → 窗口 C 里 claude 应继续并打印 `hello-from-claude`；窗口 B 在你解锁/批准后应回到 `caffeinate none`。

✅ 证明：锁屏=离开、权限卡转发、手机审批回灌、**离开保活用 `-i` 顶住休眠且事后释放**、回到本机收回。

### Phase 3 — 选择卡（AskUserQuestion，**仅 Claude**）

1. 窗口 C：`claude`，输入：`用 AskUserQuestion 工具问我两个问题：(1) 先做哪个模块，给我 3 个选项；(2) 用哪个测试框架，给我 2 个选项。等我答完再动手。`，回车。
2. **立刻 `⌃⌘Q` 锁屏。**
3. 手机收到 **多问题表单卡**（`🌈 Vonvon Bridge · …`）：每个问题一个**下拉框** + 正下方一个常驻**自定义文本框**（「都不合适？直接写这里（填了就用你写的）」），整卡一个 **✅ 提交**。多选问题用多选下拉。
4. 每题选一个（或在自定义框直接打字覆盖）→ 点 **✅ 提交**。卡片变「✅ 已回答」并列出你的答案。
5. 解锁 → claude 收到全部答案并继续。

✅ 证明：多问题选择卡转发、下拉/自定义回填、一次提交收齐。

> **Codex 不进这条路径（平台限制，非缺陷）**：Codex 的 `request_user_input`（AskUserQuestion 等价物）被源码锁在 **Plan 模式**，默认模式下运行时直接拒绝 → Codex 只会把问题当**纯文字**输出，没有结构化工具调用可拦截；且即便 Plan 模式，Codex 的 `PermissionRequest` hook 输出只支持 `systemMessage`、无法回灌答案。因此 **Codex 的问答一律走 Phase 4 的「完成卡文字 + 回复作答」**，不渲染选择卡。

### Phase 4 — 完成卡 + 续聊（Stop，**多轮**）

1. 窗口 C：`claude`，输入：`只回复四个字：测试完成`，回车。
2. **立刻 `⌃⌘Q` 锁屏。**
3. 手机收到 **「Stop 通知」完成卡**（含最终回答摘要、「⏳ 等待确认」按钮、可回复提示）。
4. 在手机上**直接回复这张卡**：`再补一句:辛苦了`。
5. claude 把你的回复当新输入继续（续聊），跑完后 **续聊结果会作为一张新的完成卡再回到飞书** —— 你可以**继续回复**，如此多轮，全程不用碰电脑。
   - 关键回归点：续聊后的那次 Stop 带 `stop_hook_active=true`，**必须仍然转发**（早期版本会被误吞，结果只留终端）。
   - 也可改测：不回复，点「⏳ 等待确认」→ agent 正常结束、卡变「已确认完成」。
6. **Codex 同理**：默认模式下 Codex 的问答/输出也以完成卡到达，回复即可让它续聊（Codex 共享 Stop 的 `decision:block+reason` 续聊契约）。

✅ 证明：完成卡转发 + **多轮**回复续聊 + 等待确认收尾。

### Phase 5 — 通知范围：仅绑定项目

> “绑定项目”= 一个已注册的飞书群对应的固定工作目录。先确认你有一个，记下它的 cwd（设置/项目卡里能看到）。

1. 手机设置卡：通知范围切到 **仅绑定项目**。
2. **在绑定项目的 cwd 里**跑 Phase 2 的权限用例（锁屏）→ 手机**应**收到卡。批准后解锁收尾。
3. **在一个非绑定目录**（如 `cd /tmp`）里再跑一次（锁屏）→ 手机**不应**收到卡；窗口 C 里 claude 直接走
   本地终端审批（解锁后你会看到它在本地等你/已按本地策略处理）。

✅ 证明：`仅绑定项目` 按 cwd 命中项目才转发。

### Phase 6 — 通知范围：不通知

1. 手机设置卡：通知范围切到 **不通知**。
2. 任意目录跑权限用例（锁屏）→ 手机**完全不应**收到任何卡。
3. 测完切回 **全部**。

✅ 证明：`不通知` 全静默。

### Phase 7 — 按后端开关：关掉 Codex

1. 手机设置卡：把 **Codex：开 → 关**（Claude 保持开）。
2. 窗口 C：`codex`，给一个需要执行命令的任务（锁屏）→ 手机**不应**收到 codex 的卡。
3. 再用 `claude` 跑权限用例（锁屏）→ 手机**仍应**收到 claude 的卡。
4. 测完把 Codex 切回 **开**。

✅ 证明：claude/codex 转发互相独立。

### Phase 8 — 在本机（不离开）= 不打扰

1. 确保通知范围 = 全部、后端都开。
2. 窗口 C 跑权限用例，**这次不要锁屏，正常坐在电脑前**（保持有鼠标/键盘活动）。
3. 手机**不应**收到卡；窗口 C 里 claude 直接走**本地终端**审批（你在本地点同意/拒绝）。

✅ 证明：在本机时静默走本地、不打扰飞书。

### Phase 9 — 本会话放行 + 中途收窄范围（回归点）

> 这条专门验证刚修的 bug：本会话放行是“静默放行、不发卡”，不该被通知范围拦截。

1. 通知范围 = **全部**。
2. 窗口 C：`cd /tmp`（一个**非绑定**目录）后 `claude`，让它连续跑两条命令，比如：
   `依次运行 echo one、再运行 echo two，两条都用 shell。`，回车后**立刻锁屏**。
3. 第一条命令的权限卡到手机 → 点 **🔁 始终允许**（本会话放行）。
4. **保持锁屏**，在手机上把通知范围切到 **不通知**（或 `仅绑定项目`）。
5. 第二条命令应被**静默放行**（不再弹卡、claude 直接继续），**而不是**掉回本地终端卡住。
   - 观测：窗口 A 日志不报错、手机没新卡、解锁后 claude 已把两条都跑完。
6. 测完切回 **全部**。

✅ 证明：`始终允许` 的会话即使中途收窄范围也仍静默放行（不降级成本地弹窗）。

### Phase 10 — 离开保活关掉

1. 手机设置卡：**离开保活：开 → 关**。
2. 窗口 B 先确认当前是 `caffeinate none`。
3. 跑权限用例（锁屏），卡到手机后**先别批准**，等几秒。
4. 窗口 B 应**始终是 `caffeinate none`**（保活关 → 不再 spawn caffeinate）。
5. 批准、解锁收尾。测完把保活切回 **开**。

✅ 证明：离开保活开关真正控制 caffeinate。

### Phase 11 — 多机器人不重复装 hooks（如果你有 ≥2 个 bot）

1. 记下当前 `jq '.hooks.PermissionRequest' ~/.claude/settings.json` 的条目数（每个 event 应只有 **1 条** bridge 命令）。
2. 切到另一个 bot 的守护进程，在它的设置卡点 **修复 hooks**。
3. 再看 `jq '.hooks.PermissionRequest' ~/.claude/settings.json`：**仍只有 1 条**（被替换成新 bot 的 `--bot`，不是叠加成 2 条）。

✅ 证明：先删后加、跨 bot 不重复堆叠。

---

## 4. 功能覆盖核对表

| # | 功能 | 对应 Phase | 期望 |
|---|---|---|---|
| 1 | 总开关 / 修复 hooks / 状态 | 1 | 开关生效、状态「已安装」 |
| 2 | 通知范围 UI 高亮 | 1 | 三档可切、当前高亮 |
| 3 | 后端独立开关 UI | 1 | claude/codex 各自切 |
| 4 | 离开保活 UI | 1,10 | 可切、控制 caffeinate |
| 5 | 锁屏=离开 | 2 | 锁屏即转发 |
| 6 | 权限卡转发 + 审批回灌 | 2 | 手机审批→本地继续 |
| 7 | 离开保活 `-i` 生效 + 释放 | 2,10 | RUNNING `-i -w`→none |
| 8 | 回到本机收回 | 2,8 | 解锁/活动→收回本地 |
| 9 | 选择卡（AskUserQuestion） | 3 | 选项/自定义回填 |
| 10 | 完成卡 + 续聊 | 4 | 回复续聊 / 等待确认 |
| 11 | 通知范围 仅绑定项目 | 5 | 命中项目才转发 |
| 12 | 通知范围 不通知 | 6 | 全静默 |
| 13 | 按后端转发独立 | 7 | 关 codex 不影响 claude |
| 14 | 在本机不打扰 | 8 | 走本地、无卡 |
| 15 | 本会话放行 + 收窄范围（回归） | 9 | 仍静默放行不降级 |
| 16 | 多 bot 不重复装 | 11 | 每 event 仅 1 条 hook |

---

## 5. 排查 & 复位

- **手机收不到卡**：确认 owner 已设、总开关开、当前确实“离开”（`ioreg ... CGSSessionScreenIsLocked` 应为 Yes）、
  通知范围不是「不通知」、对应后端是「开」。看窗口 A 日志有无 `cli-bridge started`。
- **卡片秒被收回 / 标「已转交本机」**：你在 Mac 上动了鼠标键盘（被判回到本机）。锁屏后只用手机操作。
- **claude 不弹权限卡**：Claude Code 不在“会问权限”模式（别用 skip-permissions / 自动接受）；或命令本就被允许列表放行。
- **codex 钩子不触发**：检查 `~/.codex/config.toml` 是否有 `[features] hooks = true`（重点回「修复 hooks」）。
- **caffeinate 一直在 / 不释放**：正常应在“批准 / 解锁 / 超时”后消失。若残留，`pkill -x caffeinate` 手动清，并记录复现步骤。
- **想换“离开”阈值**（不锁屏、用空闲触发）：编辑 `~/.feishu-codex-bridge/bots/<appId>/config.json` 的
  `preferences.cliBridge.presence.idleThresholdSeconds`（如设 15），**改完需重启守护进程**才生效；
  之后只要 15 秒不碰 Mac 就算离开。锁屏法更省事、且顺带测了锁屏判定，推荐优先用锁屏。
- **复位 hooks**：在设置卡关掉总开关会停桥接；要彻底清 hooks 可重装/卸载（见 `src/cli-bridge/hooks.ts` 的
  uninstall 流程）。
