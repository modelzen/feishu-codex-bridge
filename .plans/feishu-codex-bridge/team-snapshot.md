# Team Snapshot

> Generated: 2026-05-26 · Project: feishu-codex-bridge · Language: 中文
> Team Name (MCP): feishu-codex-bridge

## Roster
| Name | Role | Adapter | Model | Cwd |
|------|------|---------|-------|-----|
| service-dev | Backend Dev (M8 launchd service) | codex | default | 仓库根 |
| test-dev | Test/Backend Dev (vitest 单测) | codex | default | 仓库根 |
| reviewer | Code Reviewer (只读 review 卡片代码) | codex | default | 仓库根 |

lead = 主对话（Claude Code），写耦合的卡片 UI 核心。

## 复活命令
对每个 worker：
```
mcp__team-mode__worker_add(team="feishu-codex-bridge", name="<name>", adapter="codex",
  on_existing="reuse", system_prompt=<见下>)
```
复活后第一条 send_message 让其先 Read `.plans/feishu-codex-bridge/<name>/progress.md` + `task_plan.md` 接续。

## Onboarding Prompt 结构（恢复时重建）
每个 worker 的 system_prompt = 通用 onboarding（见 skill `references/onboarding.md` Common Template）
+ 角色段（backend-dev / reviewer）+ 末尾 "Read `.plans/feishu-codex-bridge/<name>/task_plan.md` 拿任务"。
关键协议（所有 worker 必含）：
- 唯一说话方式 = `mcp__team-mode__send_message(team="feishu-codex-bridge", text="@lead ...")`，stdout 不可见；
- 先读仓库根 `AGENTS.md` + 自己 task_plan.md；findings/progress 用 echo 追加；
- 3-Strike escalate；codex sandbox 踩坑标 `[SANDBOX]` 给 lead；hand-off 分级带证据；
- service-dev 只动 cli/index.ts 的 service 段；test-dev 只在 test/ 新建、绝不改 src；reviewer 只读、只写 review-<target>/。

各 worker 完整任务见 `.plans/feishu-codex-bridge/<name>/task_plan.md`（事实源）。
