# 后台服务使用指定的 Codex

如果要使用 PATH 之外的 Codex，安装后台服务时设置 `CODEX_BIN`。服务会保存这个选择，后台启动和重启都沿用它；重新打开终端后不必再次设置。

macOS / Linux：

```sh
CODEX_BIN="/absolute/path/to/codex" feishu-codex-bridge start
feishu-codex-bridge restart
```

Windows PowerShell：

```powershell
$env:CODEX_BIN = 'C:\Tools\Codex\codex.exe'
feishu-codex-bridge start
feishu-codex-bridge restart
```

请使用实际存在的 Codex 可执行文件；Windows 的 npm 安装也可以指定 `codex.cmd`。推荐绝对路径；相对路径会按执行 `start` 时的工作目录转为绝对路径，符号链接不会被展开，因此仍可通过更新链接目标升级 Codex。

已有服务也要带着 `CODEX_BIN` 再执行一次 `start`，才能更新旧的启动配置。Linux 和 Windows 的 `start` 会更新配置，但不会替换已经运行的进程，因此修改选择后还要执行 `restart`。macOS 的安装会重新加载服务。

- `start` 时未设置 `CODEX_BIN`：保留已经保存的选择。
- `start` 时设置新路径：更新保存的选择。
- `restart`：使用已经安装的选择，不以当前终端或旧进程中的变量重新配置。
- `stop`：停用服务，保留选择。

## 取消指定路径

macOS / Linux 可以显式传入空值，然后重启，恢复项目已有的自动查找顺序：

```sh
CODEX_BIN= feishu-codex-bridge start
feishu-codex-bridge restart
```

旧版 Windows PowerShell 会把空环境变量当作删除变量，而这里删除变量表示“保留设置”。全局 npm 安装可以通过下面的命令在 Node 进程内部设置空值并执行同一个 `start`；无需编辑配置文件：

```powershell
node -e "const p=process.argv[1];process.env.CODEX_BIN='';process.argv=[process.execPath,p,'start'];import(require('node:url').pathToFileURL(p).href)" "$(npm root -g)/@modelzen/feishu-codex-bridge/bin/feishu-codex-bridge.mjs"
feishu-codex-bridge restart
```

这个设置只决定服务使用哪个 Codex，不会增加账号权限或保证某个模型可用。模型列表仍来自实际运行的 Codex App Server。
