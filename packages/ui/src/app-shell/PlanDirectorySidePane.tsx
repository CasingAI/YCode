import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedPlanDetailSideTabRequest,
  PlanDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { buildSessionPlansModel } from "@/v4/conversationStatusPanelModel.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

export function resolvePlanDirectoryItemOverview(item: { overview?: string }): string | undefined {
  const overview = item.overview?.trim();
  return overview ? overview : undefined;
}

function buildPlanDetailOpenRequest(
  tab: PlanDirectorySidePaneTab,
  item: {
    toolCallId: string;
    markdown: string;
    planFilePath?: string;
    title?: string;
  },
): OpenScopedPlanDetailSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    parentSessionId: tab.parentSessionId,
    toolCallId: item.toolCallId,
    markdown: item.markdown,
    ...(item.planFilePath ? { planFilePath: item.planFilePath } : {}),
    ...(item.title ? { title: item.title } : {}),
  };
}

const PlanDirectoryContents = memo(function PlanDirectoryContents({
  onOpenPlanDetail,
  tab,
}: {
  onOpenPlanDetail: (request: OpenScopedPlanDetailSideTabRequest) => void;
  tab: PlanDirectorySidePaneTab;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);

  useEffect(() => {
    if (!lease || !projection.snapshot?.sessionId) return;
    void lease.store.refreshPlans();
  }, [lease, projection.snapshot?.logEpoch, projection.snapshot?.sessionId]);

  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);

  const sessionPlans = useMemo(
    () => buildSessionPlansModel(projection.sessionPlans, tab.workspacePath),
    [projection.sessionPlans, tab.workspacePath],
  );
  const items = sessionPlans?.items ?? [];
  const isLoading = projection.plansLoading && items.length === 0;
  const isUnavailable = !isLoading && projection.plansError !== null;

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "planDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {isLoading ? (
          <p
            data-testid="plan-directory-loading"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "planDirectory.loading" })}
          </p>
        ) : isUnavailable ? (
          <p
            data-testid="plan-directory-unavailable"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "planDirectory.unavailable" })}
          </p>
        ) : items.length === 0 ? (
          <p
            data-testid="plan-directory-empty"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "planDirectory.empty" })}
          </p>
        ) : (
          <ul className="space-y-0" data-testid="plan-directory-list">
            {items.map((item) => {
              const title =
                item.title ?? intl.formatMessage({ id: "chat.statusPanel.planFallback" });
              const overview = resolvePlanDirectoryItemOverview(item);
              return (
                <li key={item.toolCallId}>
                  <button
                    type="button"
                    data-plan-directory-tool-call-id={item.toolCallId}
                    aria-label={intl.formatMessage({ id: "chat.statusPanel.openPlan" }, { title })}
                    onClick={() => onOpenPlanDetail(buildPlanDetailOpenRequest(tab, item))}
                    className="flex min-h-12 w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                  >
                    <FileTextIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui-base font-medium text-foreground">
                        {title}
                      </span>
                      {overview ? (
                        // `overview` 本身就是 ExitPlanMode 要求模型写的 1-3 句短概述，
                        // 单行 truncate 会把最关键的信息（做什么、不做什么）截掉。放得下就
                        // 完整显示，最多 6 行封顶；超出的部分由 `title` 悬停和详情页承接。
                        <span
                          className="mt-0.5 line-clamp-6 block text-ui-sm text-foreground-subtle"
                          title={overview}
                        >
                          {overview}
                        </span>
                      ) : null}
                    </span>
                    <ChevronRightIcon
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-foreground-subtlest"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});

export const PlanDirectorySidePane = memo(function PlanDirectorySidePane({
  onOpenPlanDetail,
  tab,
}: {
  onOpenPlanDetail: (request: OpenScopedPlanDetailSideTabRequest) => void;
  tab: PlanDirectorySidePaneTab;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <PlanDirectoryContents onOpenPlanDetail={onOpenPlanDetail} tab={tab} />
    </V4PaneConversationProvider>
  );
});
