# service-dev — Task Plan

> Role: Backend Dev (codex) · Status: pending
> 负责 M8：macOS launchd 后台常驻服务 + CLI service 命令。

## Goal
让 `feishu-codex-bridge service install launchd` 把 bridge 注册成 macOS launchd 用户代理（崩溃自启、登录自启），并提供 status/restart/uninstall/logs。

## Scope（只在这些文件内做事，别碰别的）
- 新建 `src/service/adapter.ts`：`ServiceAdapter` 接口 `{ install(); uninstall(); status(); restart(); logs(follow) }` + 平台分发（暂只 macOS；非 mac 抛"暂不支持，后续"）。
- 新建 `src/service/launchd.ts`：
  - label `ai.feishu-codex-bridge.bot`，plist 写 `~/Library/LaunchAgents/<label>.plist`。
  - plist 的 ProgramArguments **硬编码绝对路径** `<node> <repo>/bin/feishu-codex-bridge.mjs start`（用 `process.execPath` + 解析 bin 绝对路径）；RunAtLoad=true、KeepAlive=true；stdout/stderr 重定向到 `~/.feishu-codex-bridge/service.log` / `service.err.log`（路径用 `src/config/paths.ts` 的 paths.appDir）。
  - install：写 plist → `launchctl bootstrap gui/$UID <plist>`（或 `launchctl load -w`，二选一，注释说明）。uninstall：`launchctl bootout` + 删 plist。status：`launchctl print gui/$UID/<label>` 或 list，解析 pid/last exit。restart：unload+load。logs：tail 两个 log 文件（follow 用 `tail -f` 子进程）。
- 新建 `src/cli/commands/service.ts`：`install <launchd>` / `uninstall` / `status` / `restart` / `logs [--follow]` 子命令，调 adapter。
- 接进 `src/cli/index.ts`：把现有 `service` 命令桩**替换**成真实子命令组。⚠️ cli/index.ts 是共享文件——**只动 service 那一段**，别动 start/doctor/secrets。

## 参考（思路，不抄码——无 LICENSE 的不可抄）
- `docs/references/feishu-claude-code-bridge/src/daemon/{launchd.ts,service-adapter.ts,paths.ts}`（zarazhangrui，有 LICENSE 可借鉴写法）。

## 验收
- `npm run typecheck` + `npm run build` 全绿。
- `node bin/feishu-codex-bridge.mjs service status` 能跑（未安装时友好提示）。
- 写一个 `service install launchd` 的 dry-run 或实跑（你本机可 install 后 `launchctl print` 验证，再 uninstall 清理）。
- 完成在自己 progress.md 记，reply `@lead` 带：改了哪些文件、验证命令+结果、风险。

## Non-goals
不做 Windows/systemd（接口预留即可）。不碰 bot/agent/card 任何代码。
