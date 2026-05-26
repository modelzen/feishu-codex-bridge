# feishu-codex-bridge — Main Plan

> Status: IN PROGRESS (M0–M2,M6 done; M3/M4/M5/M7 by lead; M8+tests parallel)
> Team: feishu-codex-bridge (service-dev[codex], test-dev[codex], reviewer[codex])
> 设计事实源：docs/design/feishu-codex-bridge-design.md + implementation-plan.md

## 1. 概述
飞书↔本机 Codex 桥。项目=群=cwd、话题=session。后端 codex app-server(每会话一进程)，传输 node-sdk 长连接。

## 2. 分工
- **lead(我)**：耦合的卡片 UI 核心 —— M3 会话配置卡 / M4 动态模型+恢复 / M5 横幅分支检测 / M7 全局设置卡 / 卡片渲染统一改。改 card/*、bot/handle-message、新 card/dispatcher。
- **service-dev**：M8 launchd 后台服务（src/service/* + cli service 命令）。
- **test-dev**：纯模块 vitest 单测（test/*）。
- **reviewer**：只读 review lead 的卡片代码。

## 3. 已完成
M0 脚手架 / M1 群@bot 闭环(实测过) / M2 项目管理 / M6 watchdog+steer+并发。提交线见 git log。

## 4. 当前
lead 起卡片回调分发器地基；service-dev + test-dev 并行独立切片；reviewer 待命。
