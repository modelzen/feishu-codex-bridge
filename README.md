# feishu-codex-bridge

[![npm version](https://badgen.net/npm/v/@modelzen/feishu-codex-bridge)](https://www.npmjs.com/package/@modelzen/feishu-codex-bridge)
[![total downloads](https://badgen.net/npm/dt/@modelzen/feishu-codex-bridge)](https://www.npmjs.com/package/@modelzen/feishu-codex-bridge)
[![downloads/month](https://badgen.net/npm/dm/@modelzen/feishu-codex-bridge)](https://www.npmjs.com/package/@modelzen/feishu-codex-bridge)
[![license](https://badgen.net/npm/license/@modelzen/feishu-codex-bridge)](https://github.com/modelzen/feishu-codex-bridge/blob/main/LICENSE)
[![官网](https://badgen.net/badge/%E5%AE%98%E7%BD%91/bridge.vonvon.cc/blue)](https://bridge.vonvon.cc)

🌐 **官网：<https://bridge.vonvon.cc>**

> 把飞书 / Lark 桥接到你本机的 [Codex](https://github.com/openai/codex) 或 [Claude Code](https://www.anthropic.com/claude-code)，在群里 @ 机器人就能让它在指定项目目录里干活，结果以流式 Markdown 卡片实时回到群里。
>
> **项目 = 群 = 固定工作目录（cwd）**，**话题（thread）= 一个会话（session）**。

一句话：你在飞书群里发「帮我加个登录接口」，机器人就在这个群绑定的代码目录里跑 Codex / Claude，边跑边把推理、命令、改动、结果更新到一张卡片上；点 ⏹ 可随时终止。

> 🎀 **想先看它在飞书里长啥样、能干嘛？** 看这篇图文介绍 👉 [《让 Codex 当你飞书里的同事》](https://my.feishu.cn/docx/AFKNdf4QaooL5OxSR8bc5H7vn7b)

```
飞书群消息 ──长连接──▶ bridge ──▶ Codex app-server / Claude Agent SDK（每会话一独立后端）
   ▲                      │
   └─── 流式 Markdown 卡片 ◀┘
```

---

## ⚡ 安装

两步打开本机网页控制台。装好 Bridge、打开控制台，再在页面里启动后台服务、添加第一个 Bridge 机器人。

```bash
# 1. 全局安装 Bridge
npm i -g @modelzen/feishu-codex-bridge

# 2. 打开本机网页控制台
# 启动服务、添加好机器人后，这条前台命令即可 Ctrl+C 关闭
feishu-codex-bridge web
```

不想自己敲？把下面这段发给 **Codex / Claude** 等 AI agent，让它替你装好并跑起来：

```text
帮我在这台电脑上安装并跑起来 feishu-codex-bridge：

1) 先 node -v 确认有 Node.js(≥18)，没有就先装好；
2) 再 codex --version 确认已经安装了 codex CLI，没有就先装好；
3) 全局安装：
   npm i -g @modelzen/feishu-codex-bridge
4) 前台运行，打开本机 Web 控制台：
   feishu-codex-bridge web
   它一启动会打印一个 http://127.0.0.1:xxxx/?token=... 的链接。
5) 把那个链接发给我；
6) 然后用文字告诉我接下来怎么做：
   - 我在浏览器打开这个链接；
   - 点页面上的「启动」按钮，把后台服务跑起来；
   - 启动后页面会自动进入可写控制台，在里面扫码添加我的第一个飞书机器人；
   - 成功创建机器人后，前台那条 feishu-codex-bridge web 就可以 Ctrl+C 关掉，不影响后台服务。
```

### 三分钟，看它入职你的飞书

从全局装包、打开本机网页控制台，到扫码建机器人、私聊报到，一整段带解说录屏。点击下面封面去 B 站观看高清版。

[![3 分钟跑通：飞书里直接发任务，Codex 在你本机真干活](docs/assets/install-demo-cover.jpg)](https://www.bilibili.com/video/BV1xP7V6fESb)

---

## ✨ 特性

- **群 = 项目，话题 = 会话**：每个群绑定一个本地目录；群里 @ 机器人就在该目录跑 agent。对某条消息开话题 = 一条独立连续会话（自动 resume）。
- **两种后端**：**Codex**（能力最全：goal / steer / compact / resume + 真沙箱只读档）或 **Claude Code**（SDK 内置、复用本机登录、能力较精简）。建项目时按需选，同一台机可混用。
- **流式卡片**：推理 / 命令 / 文件改动 / 结果实时刷新到一张可折叠卡片；⏹ 随时终止，卡死有 watchdog 自动回收，异常不波及其他群。
- **免 @ + 自主目标**：话题 / 单会话群里可直接说话不必每次 @；`/goal <目标>` 让它自主多轮干到完成。
- **多模态**：消息里直接发图片（读图）、发文件附件（下载到本地交给 agent 打开分析）。
- **☕ 咖啡一下（反向桥）**：离开电脑时，把你本机正在跑的 Claude Code / Codex CLI 的「需要审批 / 提问 / 任务完成」接管到飞书私聊 —— 在手机上点确认 / 回答它就继续，机器保持不睡。
- **文档评论回复**：在飞书云文档（doc / docx / sheet / bitable 多维表格，含 wiki）的评论里 @ 机器人，它读评论、跑 agent、把答案回到同一条评论线程。
- **双控制台**：私聊机器人弹交互菜单（新建项目 / 设置 / 用量 / 诊断 / 重连）；网页控制台还能管后台服务、看实时日志、扫码加机器人。
- **多飞书机器人**：一台机器注册多个机器人、可同时连接，各自项目 / 会话独立。
- **三档权限沙箱**：每个项目可设「只读 / 读写 / 完全访问」，由 OS 沙箱强制（macOS / 原生 Windows）。
- **跨平台常驻**：macOS / Windows / Linux·WSL 均可注册成后台服务、开机或登录自启、崩溃自动拉起。

---

## 💬 使用

它有两个方向 —— 飞书群指挥本机 agent，和把本机 agent 接管到飞书。

### A. 飞书群 → 本机 agent（主用法）

- **建项目**：私聊机器人 → 控制台菜单「新建项目」→ 绑定一个本地目录 → **选后端（Codex / Claude）** → 机器人建好群、置顶命令说明、把你拉进去。
- **两种群按场景选**：
  - **👥 多话题群**：@ 机器人开话题，每个话题是一条**独立会话**（上下文隔离、可并行）。适合多人协作 / 一人并行多任务。
  - **💬 单会话群**：整群就是**一条连续会话**、全程**免 @**。适合个人单线深入、像私聊一样直接聊。
- **干活**：群里 @ 机器人（或话题内免 @）描述需求，流式卡片回结果；卡片上 ⏹ 随时终止当前轮。
- **自主目标**：`/goal <目标>` 让它多轮自主执行到完成；运行卡上有 **⏹ 终止**（立刻停）和 **🎯 结束目标**（本轮跑完停）。
- **斜杠命令**：`/model`、`/resume`、`/compact`、`/context` 等，按所选后端能力自适应裁剪（Claude 不显示它不支持的项）。
- **发图 / 附件**：发图片读图、发文件（日志 / PDF / 代码）让 agent 打开分析。
- **用量**：私聊「用量」看 5h / 7d 限额（剩余 % + 重置时间）与个人统计，一键生成可转发的**战绩分享卡**（数据来自 Codex 个人资料页，需 ChatGPT 登录）。

### B. 本机 agent → 飞书（☕ 咖啡一下）

在本机用 Claude Code / Codex 干活、要离开电脑时开启「咖啡一下」：本机 agent 需要**审批 / 提问 / 报告完成**时，推到你的飞书私聊，你在手机上点一下就让它继续；机器保持不睡（屏幕可关、CPU 照跑），回到电脑自动交还终端。

---

## 🖥️ CLI 一览

日常基本只用 `start`（起后台）和 `web`（开控制台），其余动作网页里都有按钮。

```
feishu-codex-bridge run [--bot <名>]            前台启动（没配置先扫码 init；Ctrl+C 优雅退出）
feishu-codex-bridge start                       后台 daemon：装系统服务、开机/登录自启、崩溃自动拉起
feishu-codex-bridge status|logs|restart|stop    daemon 生命周期（logs -f 跟随日志）
feishu-codex-bridge update [--check]            更新到最新版（npm i -g）并自动重启 daemon
feishu-codex-bridge web [--port <端口>]          打开本机网页控制台（默认端口 51847）
feishu-codex-bridge bot init|list|use|rm        多机器人：扫码注册 / 列表 / 选要连接的 / 移除
feishu-codex-bridge doctor                      本地自检：后端 / 登录 / 当前机器人
```

> ⚠️ 后台服务必须**全局安装**（`npm i -g`），别用 npx —— 服务里硬编码了 CLI 路径，npx 临时缓存会被清理。前台 `run` 用 npx 没问题（单次进程）。

---

## ⚙️ 配置与数据

所有本地状态都在 `~/.feishu-codex-bridge/`（机器人配置、项目 / 会话注册表、AES-256-GCM 加密的密钥库）。卸载时删掉这个目录即可清干净。

### 自定义空白项目目录（可选）

「新建项目」时把**文件夹路径留空**，默认会创建到 `~/.feishu-codex-bridge/projects/<项目名>`。如需改到其他磁盘，可编辑诊断卡所显示的当前机器人 `config.json`（通常是 `~/.feishu-codex-bridge/bots/<appId>/config.json`），在已有 `preferences` 中加入：

```json
{
  "preferences": {
    "projectsRootDir": "D:\\feishu-codex-projects"
  }
}
```

也支持绝对路径和 `~/code` 这类路径。请保留配置文件里的其他字段，修改后重启 bridge；该项只影响之后留空路径创建的空白项目，不会移动已有项目，也不影响手动填写的文件夹路径。

---

## ⚠️ 安全须知

机器人跑 agent 始终是 **`approvalPolicy: never`**（无逐条人工审批），**沙箱是唯一的安全闸门**。每个项目在私聊 / 网页控制台里可设三档权限：

| 档位 | 能读 / 能写 | 适用 |
|------|------------|------|
| 🔒 **项目内只读** | 仅项目目录 / 不可写 | 外部群、不可信场景的问答机器人 |
| ✏️ **项目内读写** | 仅项目目录 | 自己的编码项目，禁止它碰机器其余部分 |
| ⚠️ **完全访问** | 整台电脑 | 完全信任、你自己掌控的机器 |

- 🔒 / ✏️ 的读写限定由 OS 沙箱强制，仅 **macOS / 原生 Windows** 可强制；**Linux·WSL 选这两档会 fail-closed 拒绝启动**（绝不静默降级为完全访问），要用请把后端跑在容器 / 隔离环境里。
- ⚠️ **完全访问** = 任何能给机器人发消息的人都能以你的身份在这台机器上执行任意命令 —— 只把信任的人拉进群、在你自己掌控的机器上跑、目录里别放敏感数据。
- 它不是多租户托管服务，是给你（和你信任的小团队）自用的桥。

---

## 🌐 Web 控制台

`feishu-codex-bridge web` 打开本机浏览器里的管理面板（只绑 `127.0.0.1` + 每次启动随机 token 鉴权），一屏搞定：扫码加机器人、开权限 / 订阅事件 checklist、启停 / 重启 / 更新后台服务、看所有 bot / 项目 / 话题 / 实时日志、后端环境检测。daemon 在跑时是可写控制台；没跑时退化为只读预览，仍可一键启动 daemon。日常管理基本只跟它和飞书私聊控制台打交道。

---

## 🧑‍💻 开发

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/
npm test            # vitest
```

`git clone https://github.com/modelzen/feishu-codex-bridge.git && cd feishu-codex-bridge && npm i`（`prepare` 自动构建），前台跑 `npm start`。架构与实现见 [`docs/design/feishu-codex-bridge-design.md`](docs/design/feishu-codex-bridge-design.md) 与 [`docs/design/implementation-plan.md`](docs/design/implementation-plan.md)。

---

## 💬 文档 & 交流

- 🌐 **官网**：<https://bridge.vonvon.cc>
- 🎀 **图文介绍**：<https://my.feishu.cn/docx/AFKNdf4QaooL5OxSR8bc5H7vn7b> —— 配大量截图，讲清它在飞书里长什么样、怎么用。
- 📖 **命令手册**：<https://my.feishu.cn/wiki/PZ23wGr7JiKK5RkIG4rcZXzGn5g> —— 各场景可用命令速查。
- 🐛 **反馈 / 贡献**：<https://github.com/modelzen/feishu-codex-bridge/issues>
- 👥 **交流群**：扫码加入「Vonvon 灵感研究所」👇

<p align="center"><img src="docs/assets/vonvon-group-qr.png" alt="Vonvon 灵感研究所 群二维码" width="300"></p>

---

## 📄 License

[MIT](LICENSE) © modelzen
