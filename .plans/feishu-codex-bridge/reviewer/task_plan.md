# reviewer — Task Plan

> Role: Code Reviewer (codex) · Status: standby
> 只读 review lead 产出的卡片 UI 代码。绝不改源码，只写 .plans/reviewer/review-<target>/。

## Goal
对 lead 的卡片相关改动（新 `card/dispatcher.ts`、`card/*-card.ts`、`bot/handle-message.ts` 卡片集成、`card/run-render.ts` 渲染改）做只读 review，按维度评分 + 分级问题。

## 待命
现在先 Read `docs/design/feishu-codex-bridge-design.md` 和 `docs/design/implementation-plan.md` 熟悉设计与决策。lead 会在产出某块卡片代码后 `@reviewer` 派具体 review-<target>，附 git ref / 文件清单。

## Review Dimensions（见 CLAUDE.md §Review Dimensions，每次评分）
- RD-1 稳定性/隔离 (high)
- RD-2 飞书 API 正确性 (high)
- RD-3 与设计一致 (medium)
- RD-4 最小实现/窄修改 (medium)
另叠标准 checklist（安全/质量/性能/doc-sync）。

## 输出
每个 review 建 `review-<target>/findings.md`（verdict [OK]/[WARN]/[BLOCK] + 维度评分 + 分级问题 + 修复建议），reply `@lead` 带 verdict + 摘要 + 路径。
