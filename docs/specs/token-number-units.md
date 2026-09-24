# Spec：Token 数量展示单位口径

## 目标

同一个 200K 上下文窗口，在设置页模型列表的容量 badge 显示 `200K`，在聊天输入框「上下文容量」浮层却显示 `20万`。原因是浮层摘要走了跟随界面语言的 `Intl` compact（中文即「万/亿」），而模型 badge 走固定 en-US 口径。

本改动确立 token 数字的展示口径边界：**容量/规格类固定 K/M/B，消耗量类跟随 locale**。

## 产品规则

- **容量/规格类 → 固定 K/M/B**（不随中文变成「万/亿」）。范围：
  - 设置页模型列表与模型表单的上下文窗口 badge（`formatModelContextWindowLabel`）。
  - 聊天输入框「上下文容量」浮层右上角摘要的 used / size（`formatContextUsageSummary`）。
  - 聊天输入框「上下文容量」浮层来源明细的来源 token 值（`formatContextUsageBreakdownLabel`）。
  - 判定依据：这类数字描述模型的容量上限或当前占用，是技术规格，跨语言应读作同一量级（`200K` / `1M`）。
- **上下文来源明细 → 同时显示来源折算值和占比**：
  - 顶部 `used / size` 是当前任务实际占用的唯一展示基数；来源行按已有来源占比计算 `displayTokens = used × normalizedPercent`，展示形如 `35.3K (85.4%)`。
  - `normalizedPercent` 继续来自 runtime breakdown 的来源字符量，先聚合同一来源，再归一化；来源折算值不是 provider 对每个来源的独立实测 token 数。
  - runtime snapshot 内部的 `categories[].tokens` 是本地诊断估算，只保留在 runtime 诊断链路，不投影为 Composer 的来源折算契约。
  - 历史事件只有 `chars` 时仍可正常展示：使用顶部实际占用和字符占比折算，不制造第二套 usage 数值。
  - 没有有效 breakdown 或 `used` 时不渲染来源值；不改变进度条、来源排序、颜色和顶部摘要口径。
- **消耗量类 → 跟随 locale compact**（中文「万/亿」）。范围：
  - 设置页用量统计（`packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx`）。
  - Start Plan 明细的 grant units（`packages/ui/src/settings/model-provider-section/StartPlanCard.tsx`）。
  - 判定依据：这类数字是累计消耗量，中文读者按「万/亿」阅读更自然，且 `StartPlanCard.tsx` 已就此做过明确选择。
- 千位以下一律原样输出（`999` 不写成 `0.99K` / `1K`）。
- 百分比、完整数字（触发器 aria-label 的 `68,432 / 200,000`）不属于本口径，保持不变。

## 接口

- `packages/ui/src/lib/tokenNumberFormat.ts`
  - `formatCompactTokenNumber(locale, value, options?)`：跟随 locale 的通用紧凑写法（消耗量类继续使用）。
  - `formatCompactTokenNumberWithMetricUnits(value, options?)`：固定 K/M/B 口径，内部委托 `formatCompactTokenNumber("en-US", …)`。
  - `formatModelContextWindowLabel(contextWindow, _locale?)`：委托 `formatCompactTokenNumberWithMetricUnits`（导出签名不变）。
  - `formatContextUsageSummary({ locale, percent, size, used })`：由 `packages/ui/src/chat-input-toolbar/contextUsage.tsx` 移入，used / size 走 K/M 口径，百分比仍用 locale 百分比格式。移出 `.tsx` 是为了让「用户实际看到的字符串」可被单测断言。
  - `formatContextUsageBreakdownLabel({ locale, percent, tokens })`：来源折算值走固定 K/M 口径，百分比仍用 locale 百分比格式；`tokens` 缺失时只返回百分比。
  - `packages/ui/src/lib/contextUsageBreakdown.ts` 的 `buildContextUsageBreakdownSegments(breakdown, usedTokens)`：聚合来源字符量、归一化占比，并按顶部实际 `usedTokens` 生成展示折算值；不承担格式化、排序或状态管理。

## 验收场景

1. 中文界面下 hover 输入框的上下文图标：摘要形如 `68.4K/200K (34.1%)`，不含「万」；百分比与改动前一致。
2. 顶部显示 `41.3K/200K` 时，来源行按来源占比显示对应折算值，例如 `35.3K (85.4%)`；来源值合计在格式化误差范围内接近 `41.3K`，不再把 runtime 原始估算 token 当成顶部占用的分项。
3. 历史来源明细只有字符量时，仍按顶部实际占用和字符占比显示折算值；没有有效 breakdown 或 `used` 时不渲染来源值。
4. used 不足千位时显示 `999/200K (0.5%)`，不出现 `1K` 之类越界取整。
5. 设置页模型列表容量 badge、设置页用量统计页数字显示与改动前完全一致。

## 验证

- 单测：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/tokenNumberFormat.test.ts packages/ui/test/contextUsageBreakdown.test.ts`
  （11 项：摘要 K/M 口径、摘要不含「万」、不足千位不取整、K/M 边界、模型 badge 同口径、消耗量反向守卫、来源折算值与百分比组合展示、来源占比归一化、used 折算闭合、非法 used/空 breakdown 回退）。
  `apps/zcode-cli/packages/core/test/session-context-tools.test.ts` 14 项通过。
- 真机（已构建桌面 renderer，CDP 9229）：重建 `packages/desktop/out/renderer` 并重载窗口后，hover 上下文触发器可打开浮层并显示摘要 `65.2K/200K (32.6%)`；当前活动会话没有来源 breakdown 数据，因此未能在真实面板中观察来源折算行，折算与组合文案由 UI 单测覆盖。
- `pnpm typecheck`、`pnpm lint`（0 error，73 warning 均来自其它在改文件）、
  `pnpm architecture:check --changed`（violations 0 / new 0）、定向 `oxfmt --check` 通过。
- 未在界面上点开设置页核对用量统计与 Start Plan 明细，该边界由反向守卫单测覆盖。
