// 子代理只读面板底部常驻 footer：模式 / 模型+思考 / 上下文用量，三项全只读。
// 数据一律读子会话自己的快照（snapshot.config / snapshot.usage），禁止回退父会话。
// 不复用 ModelConfigSelect / ThoughtLevelCycleControl / V4ComposerModeControls，
// 那些控件会写 draft；这里只做纯展示，不响应点击、不打开下拉、不写 draft。
//
// 上下文格走"复用纯函数自写"路径，不直接复用 ChatContextUsage，理由：
// ChatContextUsage 内部挂了 useOptionalTabStore、useCodingPlanQuotaResetUi（含
// entitlement / access 刷新副作用）与 7 路额度面板 props；在只读 footer 里挂它
// 会引入额度请求与 hover 刷新副作用。自写小组件只复用其门控口径
// （getRenderableTaskUsage：used<=0 或 size<=0 时隐藏该格）与文案/分段纯函数，
// hover 明细只读快照里的 breakdown，不发任何请求。
import { memo, useMemo } from "react";
import { getZCodeAgentAvailableModes, type ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { Progress } from "@/components/ui/progress.js";
import { cn } from "@/components/lib/utils.js";
import { getRenderableTaskUsage } from "@/chat-input-toolbar/contextUsage.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabelIds.js";
import {
  buildContextUsageBreakdownSegments,
  sortContextUsageBreakdownSegments,
  type ContextUsageBreakdownSegment,
} from "@/lib/contextUsageBreakdown.js";
import { formatModelDisplayName } from "@/lib/modelDisplayName.js";
import {
  formatContextUsageBreakdownLabel,
  formatContextUsageSummary,
} from "@/lib/tokenNumberFormat.js";
import { resolveModeOptionToneClass } from "@/v4/composer/composerModeTone.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export const SUBAGENT_FOOTER_TEST_IDS = {
  root: "subagent-status-footer",
  mode: "subagent-status-footer-mode",
  provider: "subagent-status-footer-provider",
  model: "subagent-status-footer-model",
  thought: "subagent-status-footer-thought",
  usageUsed: "subagent-status-footer-usage-used",
  usageMax: "subagent-status-footer-usage-max",
} as const;

// footer 自己的容器断点：三项全显（默认）→ ≤320px 隐去模型+思考 → ≤220px 再隐去模式。
// 上下文只占一个小图标+百分比，常驻显示，不为它设降级档。
// 阈值依据：典型侧栏宽 320~400px；320px 下"模式徽标+模型名+百分比"三格挤作一团
// （模型名截断到只剩两三个字），先砍最宽的模型格；220px 下连"模式徽标+百分比"
// 都放不下（模式名 Plan/Ask/Agent/Bare + 百分比约 160px，加上 padding 已近 220），
// 再砍模式格，只剩百分比。长模型名靠 truncate 收敛，不挤压上下文格。
//
// 容器名统一走 SUBAGENT_FOOTER_CONTAINER；但三处 class 刻意保留完整字面量而不是
// 模板拼接：Tailwind 靠扫描源码整串类名生成 CSS，拼出来的串扫不到，样式会静默丢失。
// 改名时三处一起改，单测按本常量逐一校验三处的容器名后缀，错配即红。
export const SUBAGENT_FOOTER_CONTAINER = "subagent-footer";
const FOOTER_MODEL_CELL_CLASS =
  "flex min-w-0 flex-1 items-center gap-1 @max-[320px]/subagent-footer:hidden";
const FOOTER_MODE_CELL_CLASS = "flex min-w-0 shrink-0 @max-[220px]/subagent-footer:hidden";

// 明细来源标签与 ChatContextUsage 同一套i18n key（其内部 BREAKDOWN_SOURCE_LABEL_ID
// 未导出，这里按同一映射复述，保证两处说同一个词）。
const BREAKDOWN_SOURCE_LABEL_ID: Record<ContextUsageBreakdownSegment["source"], string> = {
  messages: "chat.contextUsage.breakdown.messages",
  system_prompt: "chat.contextUsage.breakdown.systemPrompt",
  meta_user_context: "chat.contextUsage.breakdown.metaUserContext",
  skills: "chat.contextUsage.breakdown.skills",
  tool_prompt: "chat.contextUsage.breakdown.toolPrompt",
  system_tool_schemas: "chat.contextUsage.breakdown.systemTools",
  mcp_tool_schemas: "chat.contextUsage.breakdown.mcpTools",
};

// footer hover 明细的分段管线：聚合（build）+ 展示排序（sort），与输入框
// ChatContextUsage 共用同一个 sort 实现。抽成可导出的纯函数：组件与单测都调它，
// 若有人把组件内改回未排序，单测即红（此前单测自己拼管线，改组件测不出）。
export function resolveSubagentFooterBreakdown(
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | undefined,
  usedTokens: number | undefined,
): ContextUsageBreakdownSegment[] {
  return sortContextUsageBreakdownSegments(
    buildContextUsageBreakdownSegments(breakdown, usedTokens),
  );
}

// ChatContextUsage 的门控口径：used<=0 或 size<=0 时隐藏该格，不渲染 0% 假数据。
function resolveFooterTaskUsage(snapshot: ConversationSnapshot | null | undefined) {
  const contextWindow = snapshot?.usage?.contextWindow;
  if (!contextWindow) return null;
  return getRenderableTaskUsage({
    used: contextWindow.usedTokens,
    size: contextWindow.maxTokens,
  });
}

function resolveModeLabel(mode: string | undefined): string {
  const normalized = (mode ?? "yolo").trim().toLowerCase();
  const entry = getZCodeAgentAvailableModes().find((item) => item.id === normalized);
  // 未知值回退 Agent：与 normalizeAvailableZCodeMode 的归一口径一致（非四档一律 yolo）。
  // 显示名中英文一致为 Plan / Ask / Agent / Bare（见 mode.label.glm.* 两份 locale）。
  return entry?.name ?? "Agent";
}

interface SubagentStatusFooterProps {
  snapshot: ConversationSnapshot | null | undefined;
  sessionId: string | null;
}

/** 子代理只读面板底部常驻行：shrink-0，不参与滚动、不写 draft、不发网络请求。 */
export const SubagentStatusFooter = memo(function SubagentStatusFooter({
  snapshot,
  sessionId,
}: SubagentStatusFooterProps) {
  const { intl, locale } = useZCodeIntl();

  // 必须读子会话自己的快照：SessionPane 里 snapshot 已按 lease(sessionId=childSessionId)
  // 投影，这里再按 snapshot.sessionId === sessionId 校验，身份不对直接按空态处理，
  // 禁止回退父会话数值。
  const ownSnapshot = snapshot?.sessionId === sessionId ? snapshot : null;
  const config = ownSnapshot?.config ?? null;

  const modeValue = (config?.mode ?? "yolo").trim().toLowerCase();
  const modeLabel = resolveModeLabel(config?.mode);
  const modeToneClass = resolveModeOptionToneClass(modeValue);

  const modelId = config?.model?.trim() ?? "";
  const providerId = config?.provider?.trim() ?? "";
  const thoughtValue = config?.thought?.trim() ?? "";
  const modelLabel = modelId ? formatModelDisplayName(modelId) : "";
  const thoughtLabelId = thoughtValue ? thoughtLevelLabelId(thoughtValue) : undefined;
  const thoughtLabel =
    thoughtLabelId !== undefined ? intl.formatMessage({ id: thoughtLabelId }) : thoughtValue;

  const renderableTaskUsage = useMemo(
    () => resolveFooterTaskUsage(ownSnapshot),
    // ownSnapshot 派生自 snapshot/sessionId，identity 变化即重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownSnapshot],
  );
  const usageContextWindow = ownSnapshot?.usage?.contextWindow;
  const usagePercent =
    renderableTaskUsage != null
      ? Math.min(Math.max(renderableTaskUsage.used / renderableTaskUsage.size, 0), 1)
      : 0;
  const usageSummary = renderableTaskUsage
    ? formatContextUsageSummary({
        locale,
        percent: usagePercent,
        size: renderableTaskUsage.size,
        used: renderableTaskUsage.used,
      })
    : null;
  const breakdownSegments = useMemo(
    () => resolveSubagentFooterBreakdown(usageContextWindow?.breakdown, renderableTaskUsage?.used),
    [usageContextWindow?.breakdown, renderableTaskUsage?.used],
  );
  const usageAriaLabel = renderableTaskUsage
    ? intl.formatMessage(
        { id: "chat.contextUsage" },
        {
          used: new Intl.NumberFormat(locale).format(renderableTaskUsage.used),
          total: new Intl.NumberFormat(locale).format(renderableTaskUsage.size),
        },
      )
    : intl.formatMessage({
        id: "subagentStatusFooter.contextUsageUnavailable",
      });

  return (
    <div
      data-testid={SUBAGENT_FOOTER_TEST_IDS.root}
      data-subagent-footer-mode={modeValue}
      data-subagent-footer-provider={providerId}
      data-subagent-footer-model={modelId}
      data-subagent-footer-thought={thoughtValue}
      data-subagent-footer-usage-used={renderableTaskUsage?.used ?? ""}
      data-subagent-footer-usage-max={renderableTaskUsage?.size ?? ""}
      className="@container/subagent-footer flex h-7 shrink-0 items-center gap-2 border-t border-border bg-background px-3 text-ui-xs text-foreground-subtle"
    >
      <span
        data-testid={SUBAGENT_FOOTER_TEST_IDS.mode}
        title={intl.formatMessage({ id: "subagentStatusFooter.mode" }, { mode: modeLabel })}
        className={cn(
          "items-center gap-1 font-medium whitespace-nowrap",
          FOOTER_MODE_CELL_CLASS,
          modeToneClass,
        )}
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
        <span className="truncate">{modeLabel}</span>
      </span>
      {modelLabel ? (
        <span
          title={`${providerId ? `${providerId}/` : ""}${modelId}`}
          className={cn("text-foreground-subtle", FOOTER_MODEL_CELL_CLASS)}
        >
          <span data-testid={SUBAGENT_FOOTER_TEST_IDS.provider} className="hidden">
            {providerId}
          </span>
          <span data-testid={SUBAGENT_FOOTER_TEST_IDS.model} className="truncate font-mono">
            {modelLabel}
          </span>
          {thoughtLabel ? (
            <span data-testid={SUBAGENT_FOOTER_TEST_IDS.thought} className="shrink-0 truncate">
              {intl.formatMessage(
                { id: "subagentStatusFooter.thoughtSuffix" },
                { level: thoughtLabel },
              )}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center">
        {renderableTaskUsage && usageSummary ? (
          <Context usedTokens={renderableTaskUsage.used} maxTokens={renderableTaskUsage.size}>
            {/* 只读：传 span 孩子，避免 ContextTrigger 默认渲染 <button>；
                hover 明细保留，点击无任何动作、不写 draft。 */}
            <ContextTrigger>
              <span
                aria-label={usageAriaLabel}
                data-testid="subagent-status-footer-usage-trigger"
                className="flex h-6 cursor-default items-center gap-1.5 rounded-md px-1.5 text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground"
              >
                <span
                  aria-hidden="true"
                  data-testid={SUBAGENT_FOOTER_TEST_IDS.usageUsed}
                  className="hidden"
                >
                  {renderableTaskUsage.used}
                </span>
                <span
                  aria-hidden="true"
                  data-testid={SUBAGENT_FOOTER_TEST_IDS.usageMax}
                  className="hidden"
                >
                  {renderableTaskUsage.size}
                </span>
                <span aria-hidden="true" className="size-3.5 shrink-0">
                  <svg
                    aria-hidden="true"
                    className="size-3.5"
                    focusable="false"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      fill="none"
                      opacity="0.25"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <circle
                      cx="12"
                      cy="12"
                      fill="none"
                      opacity="0.7"
                      r="10"
                      stroke="currentColor"
                      strokeDasharray={`${2 * Math.PI * 10} ${2 * Math.PI * 10}`}
                      strokeDashoffset={2 * Math.PI * 10 * (1 - usagePercent)}
                      strokeLinecap="round"
                      strokeWidth="4"
                      style={{
                        transform: "rotate(-90deg)",
                        transformOrigin: "center",
                      }}
                    />
                  </svg>
                </span>
                <span className="font-mono whitespace-nowrap tabular-nums">{usageSummary}</span>
              </span>
            </ContextTrigger>
            <ContextContent className="!w-80 !rounded-xl !shadow-md" side="top" sideOffset={4}>
              <ContextContentBody className="space-y-2">
                <div className="mb-3 flex min-w-0 items-center gap-3">
                  <span className="shrink-0 text-ui-base font-medium text-foreground">
                    {intl.formatMessage({ id: "chat.contextUsage.title" })}
                  </span>
                  <span className="ml-auto shrink-0 text-right font-mono text-ui-sm text-foreground-subtle">
                    {usageSummary}
                  </span>
                </div>
                <Progress
                  className="h-2 bg-surface"
                  indicatorClassName="min-w-2"
                  value={usagePercent * 100}
                />
                {breakdownSegments.length > 0 ? (
                  <div
                    aria-label={intl.formatMessage({
                      id: "chat.contextUsage.breakdown",
                    })}
                    className="grid gap-1.5 pt-1"
                  >
                    {breakdownSegments.map((segment) => (
                      <div
                        className="flex min-w-0 items-center gap-2 text-ui-sm"
                        key={segment.source}
                      >
                        <span className="min-w-0 truncate text-foreground-subtle">
                          {intl.formatMessage({
                            id: BREAKDOWN_SOURCE_LABEL_ID[segment.source],
                          })}
                        </span>
                        <span className="ml-auto min-w-16 shrink-0 text-right font-mono text-ui-sm whitespace-nowrap tabular-nums text-foreground">
                          {formatContextUsageBreakdownLabel({
                            locale,
                            percent: segment.percent,
                            tokens: segment.displayTokens,
                          })}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </ContextContentBody>
            </ContextContent>
          </Context>
        ) : (
          <span
            aria-label={usageAriaLabel}
            className="flex h-6 items-center px-1.5 text-ui-xs text-foreground-subtlest"
          >
            {intl.formatMessage({
              id: "subagentStatusFooter.contextUsageUnavailableShort",
            })}
          </span>
        )}
      </span>
    </div>
  );
});
