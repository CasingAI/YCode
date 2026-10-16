// 子代理只读面板底部常驻 footer：模式 / 模型+思考 / 上下文用量，三项全只读。
// 数据一律读子会话自己的快照（snapshot.config / snapshot.usage），禁止回退父会话。
// 不复用 ModelConfigSelect / ThoughtLevelCycleControl / V4ComposerModeControls，
// 那些控件会写 draft；这里只做纯展示，不响应点击、不打开下拉、不写 draft。
//
// 上下文格复用无副作用的 ContextUsageDisplay；不挂 ChatContextUsage，避免将额度刷新
// 与 access 请求带入只读 footer。
import { memo, useMemo } from "react";
import { getZCodeAgentAvailableModes } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { cn } from "@/components/lib/utils.js";
import {
  ContextUsageDetails,
  ContextUsageTrigger,
} from "@/chat-input-toolbar/ContextUsageDisplay.js";
import { getRenderableTaskUsage } from "@/chat-input-toolbar/contextUsage.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabelIds.js";
import { formatModelDisplayName } from "@/lib/modelDisplayName.js";
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
// 上下文只占一个圆环，常驻显示，不为它设降级档。
// 阈值依据：典型侧栏宽 320~400px；320px 下模式徽标、模型名与上下文圆环挤作一团，
// 模型名截断后仍先砍最宽的模型格；220px 下再砍模式格，只保留上下文圆环。
// 长模型名靠 truncate 收敛，不挤压上下文格。
//
// 容器名统一走 SUBAGENT_FOOTER_CONTAINER；但三处 class 刻意保留完整字面量而不是
// 模板拼接：Tailwind 靠扫描源码整串类名生成 CSS，拼出来的串扫不到，样式会静默丢失。
// 改名时三处一起改，单测按本常量逐一校验三处的容器名后缀，错配即红。
export const SUBAGENT_FOOTER_CONTAINER = "subagent-footer";
const FOOTER_MODEL_CELL_CLASS =
  "flex min-w-0 flex-1 items-center gap-1 @max-[320px]/subagent-footer:hidden";
const FOOTER_MODE_CELL_CLASS = "flex min-w-0 shrink-0 @max-[220px]/subagent-footer:hidden";

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
  const usageAriaLabel = intl.formatMessage({
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
      className="@container/subagent-footer flex h-8 shrink-0 items-center gap-2 border-t border-border bg-background px-3 text-ui-xs text-foreground-subtle"
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
        {renderableTaskUsage ? (
          <Context usedTokens={renderableTaskUsage.used} maxTokens={renderableTaskUsage.size}>
            <ContextTrigger
              aria-label={intl.formatMessage(
                { id: "chat.contextUsage" },
                {
                  used: new Intl.NumberFormat(locale).format(renderableTaskUsage.used),
                  total: new Intl.NumberFormat(locale).format(renderableTaskUsage.size),
                },
              )}
              data-testid="subagent-status-footer-usage-trigger"
            >
              <ContextUsageTrigger
                usedTokens={renderableTaskUsage.used}
                maxTokens={renderableTaskUsage.size}
                density="footer"
                data-testid="subagent-status-footer-usage-trigger"
              />
            </ContextTrigger>
            <ContextContent className="!w-80 !rounded-xl !shadow-md" side="top" sideOffset={2}>
              <ContextContentBody>
                <ContextUsageDetails
                  usedTokens={renderableTaskUsage.used}
                  maxTokens={renderableTaskUsage.size}
                  breakdown={usageContextWindow?.breakdown ?? undefined}
                  cacheHitRate={usageContextWindow?.cache?.hitRate}
                />
              </ContextContentBody>
            </ContextContent>
            <span data-testid={SUBAGENT_FOOTER_TEST_IDS.usageUsed} className="hidden">
              {renderableTaskUsage.used}
            </span>
            <span data-testid={SUBAGENT_FOOTER_TEST_IDS.usageMax} className="hidden">
              {renderableTaskUsage.size}
            </span>
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
