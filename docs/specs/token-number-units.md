# Spec：Token 数量展示单位口径

## 目标

同一个 200K 上下文窗口，在设置页模型列表的容量 badge 显示 `200K`，在聊天输入框「上下文容量」浮层却显示 `20万`。原因是浮层摘要走了跟随界面语言的 `Intl` compact（中文即「万/亿」），而模型 badge 走固定 en-US 口径。

本改动确立 token 数字的展示口径边界：**容量/规格类固定 K/M/B，消耗量类跟随 locale**。

## 产品规则

- **容量/规格类 → 固定 K/M/B**（不随中文变成「万/亿」）。范围：
  - 设置页模型列表与模型表单的上下文窗口 badge（`formatModelContextWindowLabel`）。
  - 聊天输入框「上下文容量」浮层右上角摘要的 used / size（`formatContextUsageSummary`）。
  - 判定依据：这类数字描述模型的容量上限或当前占用，是技术规格，跨语言应读作同一量级（`200K` / `1M`）。
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

## 验收场景

1. 中文界面下 hover 输入框的上下文图标：摘要形如 `68.4K/200K (34.1%)`，不含「万」；百分比与改动前一致。
2. used 不足千位时显示 `999/200K (0.5%)`，不出现 `1K` 之类越界取整。
3. 设置页模型列表容量 badge、设置页用量统计页数字显示与改动前完全一致。

## 验证

- 单测：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/tokenNumberFormat.test.ts`
  （6 项：摘要 K/M 口径、摘要不含「万」、不足千位不取整、K/M 边界、模型 badge 同口径、消耗量反向守卫）。
  `packages/ui/test` 全量 176 项通过。
- 真机（dev 桌面应用，CDP 9229）：重建 `packages/desktop/out/renderer` 并重载窗口后 hover 上下文触发器，
  浮层摘要由改动前的 `6.4万/20万 (32.2%)` 变为 `110.7K/200K (55.3%)`，百分比与分项占比不变。
- `pnpm typecheck`、`pnpm lint`（0 error，73 warning 均来自其它在改文件）、
  `pnpm architecture:check --changed`（violations 0 / new 0）、`oxfmt --check` 通过。
- 未在界面上点开设置页核对用量统计与 Start Plan 明细，该边界由反向守卫单测覆盖。
