#!/usr/bin/env bash
# 一键：安装依赖 → 构建 → 前台启动 bot 长连接。
# 适合 git worktree 里首次跑（worktree 不共享 node_modules）。
# 用法：bash scripts/dev-run.sh   或   ./scripts/dev-run.sh
set -euo pipefail

# 切到仓库根（脚本所在目录的上一级），无论从哪调用都对
cd "$(dirname "$0")/.."

echo "==> [1/3] 安装依赖 (npm ci 优先，无 lock 回退 npm install)"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "==> [2/3] 构建 (tsup)"
npm run build

echo "==> [3/3] 前台启动 (node bin/feishu-codex-bridge.mjs start)"
echo "    Ctrl-C 退出。"
exec npm run start
