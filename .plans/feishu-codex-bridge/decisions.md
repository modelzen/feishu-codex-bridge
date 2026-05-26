# Decisions
> 详见 docs/design/feishu-codex-bridge-design.md（设计决策权威源）。

## 2026-05-26 · 会话配置卡去掉 `fast` 下拉
- **背景**：grill 阶段定的配置卡字段是 `模型 / effort / fast`，照搬 feishu-claude-code-bridge。
- **事实**：codex app-server 的 `TurnStartParams` / `ThreadStartParams` 只有 `model` + `effort`（+ sandbox/approvalPolicy，本桥固定）。**没有 `fast` 参数**——"fast" 是 Claude Code 的概念（Opus 快速输出），对 codex 无映射。
- **决策**：配置卡只保留 `模型 ▾` + `effort ▾`。effort 已是速度/质量的调节杆，再放一个 no-op 的 fast 下拉只会误导。
- **影响**：design §3.2/§3.3 的 `fast ▾` 删除；用户测试时如坚持要 fast 概念，再讨论映射（可能映射到某个快速 model）。

## 2026-05-26 · 恢复历史会话用 codex `thread/list`
- codex app-server 有 `thread/list`，支持 `cwd` 过滤、`searchTerm`、按 createdAt 倒序、`limit`，返回 `Thread{ id, preview(首条用户消息), createdAt, updatedAt, name }`。
- **决策**：M4 恢复列表直接查 codex 自己的 thread store（事实源），不再自建"最近会话"列表。`thread/resume({threadId})` 优先用 thread_id 恢复。
- session-store（sessions.json）仍保留：映射 **飞书话题 thread_id → codex thread_id + 本会话 model/effort**，用于①重启后话题内 @bot 能 resume 回正确的 codex 线程而非新开；②⚙️ 改本会话参数的持久化。
