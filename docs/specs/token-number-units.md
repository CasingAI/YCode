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
  - **折算值按整 token 取整**（`Math.round`），千位以下一律显示整数，不出现 `305.7` 这类小数。token 计数不存在小数，来源占比本来就是估算，展示到小数位属于虚假精度。
  - 取整后各来源求和不再严格等于 `used`，偏差上界为「来源数量 ÷ 2」个 token（7 个来源最多 3.5）。这个量级相对上下文窗口不可见；明细行的百分比仍是未取整的精确归一化值，占比信息不丢。
  - `normalizedPercent` 来自 runtime breakdown 的**加权 token 估算量**（`tokens`），先聚合同一来源，再归一化；来源折算值不是 provider 对每个来源的独立实测 token 数。
  - **中英文加权口径**：runtime 的 `estimateTokens` 按「中文字符 ≈ 0.6 token、其余字符 ≈ 0.3 token」估算，中文字符判定覆盖汉字、CJK 标点与全角形式（`zcode.estimateTokens.v2`）。纯字符数占比会把英文为主的工具定义高估、把中文为主的消息低估，因此占比基准取加权 token 量而非字符数。
  - **占比基准的回退规则**：条目带合法 `tokens` 时按 `tokens` 聚合；**仅当全部条目都缺 `tokens`** 时才回退到 `chars`。不做逐条混用——半数条目按 token、半数按字符得到的是两个不同量纲的占比，比统一用字符数更错。`chars` 始终保留在契约中，用于来源排序与字符量诊断。
  - 历史事件只有 `chars` 时仍可正常展示：走上述回退路径，使用顶部实际占用和字符占比折算，不制造第二套 usage 数值。
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
  - `formatContextUsageBreakdownLabel({ locale, percent, tokens })`：来源折算值走固定 K/M 口径，百分比仍用 locale 百分比格式；`tokens` 缺失时只返回百分比。千位以下的 `tokens` 强制 `maximumFractionDigits: 0`，即使传入浮点数也只输出整数；千位及以上保留 1 位（`5.1K` 这类缩放值需要）。
  - `packages/ui/src/lib/contextUsageBreakdown.ts` 的 `buildContextUsageBreakdownSegments(breakdown, usedTokens)`：按加权 token 估算量聚合来源、归一化占比，并按顶部实际 `usedTokens` 生成**已取整**的展示折算值；全部条目缺 `tokens` 时回退按字符量聚合；不承担格式化、排序或状态管理。
- `apps/zcode-cli/packages/core/src/context/utils.ts` 的 `estimateTokens(text)`：中文字符 × 0.6、其余字符 × 0.3 后向上取整，中文字符判定覆盖汉字、CJK 标点与全角形式。

## 验收场景

1. 中文界面下 hover 输入框的上下文图标：摘要形如 `68.4K/200K (34.1%)`，不含「万」；百分比与改动前一致。
2. 顶部显示 `41.3K/200K` 时，来源行按加权 token 占比显示对应折算值，例如 `35.3K (85.4%)`；来源值合计在取整误差范围内接近 `41.3K`（偏差不超过来源数 ÷ 2），不引入与顶部 provider 真值并列的第二套 usage 数值。
3. 中文占比高的会话中，「消息」行的折算值与百分比高于纯字符占比口径；英文为主的「系统工具」「MCP 工具」行占比低于纯字符占比口径，两个方向同时成立。
4. 历史来源明细只有字符量时，整组回退按字符占比显示折算值；部分条目缺 `tokens` 时同样整组回退，不混用两种量纲。没有有效 breakdown 或 `used` 时不渲染来源值。
5. used 不足千位时显示 `999/200K (0.5%)`，不出现 `1K` 之类越界取整。
6. 来源明细里千位以下的折算值显示整数（如 `306 (1.3%)`、`50 (0.2%)`），明细区不出现任何带小数点的 token 数；千位及以上的行保持一位小数。
7. 设置页模型列表容量 badge、设置页用量统计页数字显示与改动前完全一致。

## 验证

- 单测：
  - `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/contextUsageBreakdown.test.ts packages/ui/test/tokenNumberFormat.test.ts packages/ui/test/getContextUsageRender.test.ts` — 27 项通过。其中 `contextUsageBreakdown.test.ts` 覆盖 token 基准占比、同源按 token 累加、部分缺 token 整组回退、非法 token 回退、历史事件回退、闭合偏差。
  - `TSX_TSCONFIG_PATH=apps/zcode-cli/packages/core/tsconfig.json node --import tsx --test apps/zcode-cli/packages/core/test/context-token-estimate.test.ts` — 9 项通过，覆盖双权重常量、全角标点计入中文、混合累加、整数向上取整。
  - `apps/zcode-cli/packages/core/test/session-context-tools.test.ts` 18 项通过（投影用例已按新契约改写，并补 token 非法与历史事件缺字段两条兜底）。
- `pnpm typecheck`（主仓库与 `apps/zcode-cli` 子项目）、`pnpm architecture:check --changed`（violations 0 / new 0）通过。
- 本次改动的文件 oxlint 为 0 error / 0 warning；`pnpm fmt:check` 的存量问题文件不含本次改动文件。
- **真机验收未执行**：验收场景 3 的双向变化（中文占比高的会话「消息」行上升、英文为主的「系统工具」「MCP 工具」行下降）目前只有单测覆盖，未在桌面端实际浮层中观察。
- 已知未处理：`compact/manual.ts` 的 `estimateMessageTokens` 仍是纯 `length ÷ 3`、零中文权重的独立估算器，与本次加权口径分裂，影响自动压缩触发时机，属独立行为变更。
- 未在界面上点开设置页核对用量统计与 Start Plan 明细，该边界由反向守卫单测覆盖。
