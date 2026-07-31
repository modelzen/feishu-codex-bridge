#!/usr/bin/env bash
# 发布 @modelzen/feishu-codex-bridge 到 npm —— 幂等、不会重复发、自动打 tag。
#
# 逻辑：
#   1. 前置门：装了 npm、已 npm login、工作区无未提交(已跟踪)改动。
#   2. 质量门：typecheck / test / build，任一失败即中止。
#   3. 选版本：当前 package.json 版本若「npm 上已存在」→ 从 max(本地,线上) 自动
#      patch 递增到第一个 npm 上不存在的号；否则直接发它。发布前二次校验目标号
#      不存在，双保险绝不重复发。
#   4. 发布：npm version 打 commit+tag → npm publish → git push --follow-tags
#      → 若装了 gh，再建 GitHub Release。
#
# 用法：
#   npm run release              正式发布
#   npm run release -- --dry-run 演练（走完整流程，但所有副作用只打印不执行）
#   RELEASE_SKIP_TEST=1 npm run release   跳过 test（不建议）
set -eo pipefail

PKG="@modelzen/feishu-codex-bridge"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

c() { printf '\033[1;%sm%s\033[0m\n' "$1" "$2"; }
step() { c 36 "▸ $1"; }
die() { c 31 "✗ $1" >&2; exit 1; }
# 包装有副作用的命令：dry-run 时只打印，正式时执行 —— 让 --dry-run 覆盖整条正式路径。
run() { if [ "$DRY" = 1 ]; then c 90 "  [dry-run] $*"; else "$@"; fi; }

published() { npm view "$PKG@$1" version >/dev/null 2>&1; }   # 退出0 = 该版本已在 npm
bump() { awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}' <<<"$1"; }
vmax() { node -e 'const p=s=>s.split(".").map(Number),a=p(process.argv[1]),b=p(process.argv[2]);process.stdout.write((a[0]-b[0]||a[1]-b[1]||a[2]-b[2])>=0?process.argv[1]:process.argv[2])' "$1" "$2"; }

# ── 前置门 ──────────────────────────────────────────────
command -v npm >/dev/null || die "环境里没有 npm"
if [ "$DRY" = 0 ]; then
  npm whoami >/dev/null 2>&1 || die "未登录 npm —— 先跑：npm login"
fi
if [ -n "$(git status --porcelain -uno)" ]; then
  git status -s -uno
  die "有未提交的(已跟踪)改动，先 commit 再发"
fi

# ── 质量门 ──────────────────────────────────────────────
step "typecheck / test / build"
npm run typecheck
[ "${RELEASE_SKIP_TEST:-0}" = 1 ] || npm test
npm run build
npm run verify:package

# ── 选一个 npm 上还不存在的版本号 ───────────────────────
LOCAL=$(node -p "require('./package.json').version")
REMOTE=$(npm view "$PKG" version 2>/dev/null || true)
step "本地 $LOCAL · 线上 ${REMOTE:-未发布过}"

NEED_BUMP=0
TARGET="$LOCAL"
if published "$LOCAL"; then
  base="$LOCAL"
  [ -n "$REMOTE" ] && base=$(vmax "$LOCAL" "$REMOTE")
  TARGET=$(bump "$base")
  while published "$TARGET"; do TARGET=$(bump "$TARGET"); done
  NEED_BUMP=1
fi
c 33 "→ 目标版本：$TARGET"
TAG="v$TARGET"

# 双保险：绝不重复发
if published "$TARGET"; then die "$TARGET 已存在于 npm，中止（不重复发）"; fi

# ── 发布 ────────────────────────────────────────────────
if [ "$NEED_BUMP" = 1 ]; then
  step "bump 版本号 → ${TARGET} [commit + tag ${TAG}]"
  run npm version "$TARGET" -m "chore(release): %s"
else
  step "版本号已是 $TARGET，准备发布"
fi

step "npm publish"
run npm publish

# NEED_BUMP=0 时 npm version 没跑，确保 tag 存在
if [ "$NEED_BUMP" = 0 ]; then
  if git rev-parse "$TAG" >/dev/null 2>&1; then
    c 90 "  tag $TAG 已存在，跳过"
  else
    step "打 tag $TAG"
    run git tag -a "$TAG" -m "chore(release): $TARGET"
  fi
fi

step "git push --follow-tags"
run git push --follow-tags

# ── GitHub Release（装了 gh 才做，失败不影响已发布的 npm 包）────
if command -v gh >/dev/null 2>&1; then
  step "gh release create ${TAG} [GitHub Release]"
  if [ "$DRY" = 1 ]; then
    c 90 "  [dry-run] gh release create $TAG --title $TAG --generate-notes"
  elif gh release create "$TAG" --title "$TAG" --generate-notes; then
    :
  else
    c 33 "  ⚠ GitHub Release 创建失败（npm 已发布、tag 已推，不影响）。"
    c 33 "    可手动补：gh release create $TAG --generate-notes"
  fi
else
  c 90 "  未装 gh，跳过 GitHub Release（git tag $TAG 已推送）"
fi

c 32 "✓ 已发布 ${PKG}@${TARGET} [tag ${TAG}]"
[ "$DRY" = 1 ] && c 90 "（以上为 --dry-run 演练，未产生任何实际副作用）"
exit 0
