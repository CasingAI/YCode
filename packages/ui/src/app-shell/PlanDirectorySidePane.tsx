import { memo, useEffect, useMemo, useState } from "react";
import { ArrowDownWideNarrowIcon, ChevronRightIcon, FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedPlanDetailSideTabRequest,
  PlanDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatPlanCreatedAt } from "@/app-shell/planDirectoryTime.js";
import { buildSessionPlansModel } from "@/v4/conversationStatusPanelModel.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

export function resolvePlanDirectoryItemOverview(item: { overview?: string }): string | undefined {
  const overview = item.overview?.trim();
  return overview ? overview : undefined;
}

/**
 * 目录排序规则的常驻说明，**刻意是禁用的**：排序固定按创建时间降序，没有第二选项，
 * 也就没有可切换的状态。做成可点的控件只会诱导用户点一个不会变化的东西；`title`
 * 让禁用态仍能悬停看到规则，让「第一条就是最新的」这件事不必靠猜。
 *
 * 只收文案、不依赖会话数据层，导出出来是为了能在没有 provider 的情况下直接渲染断言。
 */
export const PlanDirectorySortIndicator = memo(function PlanDirectorySortIndicator({
  label,
}: {
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled
      title={label}
      data-testid="plan-directory-sort-indicator"
      data-plan-directory-sort="createdAt"
      className="shrink-0 cursor-default text-foreground-subtlest"
    >
      <ArrowDownWideNarrowIcon aria-hidden="true" />
      <span>{label}</span>
    </Button>
  );
});

/**
 * 目录项 → 详情 tab 请求。
 *
 * `toolCallId` 缺席（历史无 frontmatter 的计划文件）时照常打开：详情页用条目自带的
 * `markdown` 冻结内容显示，只是不带路径操作——那份文件确实存在，只是对不上某次调用。
 */
function buildPlanDetailOpenRequest(
  tab: PlanDirectorySidePaneTab,
  item: {
    markdown: string;
    planFilePath?: string;
    planId: string;
    title?: string;
    toolCallId?: string;
  },
): OpenScopedPlanDetailSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    parentSessionId: tab.parentSessionId,
    markdown: item.markdown,
    planId: item.planId,
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
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
  const { intl, locale } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);

  // 挂载时读一次；`planDirectoryRevision` 递增时再读——那正是「有 ExitPlanMode 相关的行
  // 在动」的信号，也就是新计划落盘的时刻。侧栏开着时必须跟着更新，否则用户刚提交完计划
  // 看到的还是那一份少一条的目录。
  useEffect(() => {
    if (!lease || !projection.snapshot?.sessionId) return;
    void lease.store.refreshPlans();
  }, [
    lease,
    projection.snapshot?.logEpoch,
    projection.snapshot?.sessionId,
    projection.planDirectoryRevision,
  ]);

  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);

  // 协议已按创建时间降序排好，UI 不重排。
  const sessionPlans = useMemo(
    () => buildSessionPlansModel(projection.sessionPlans),
    [projection.sessionPlans],
  );
  const items = sessionPlans?.items ?? [];
  const isLoading = projection.plansLoading && items.length === 0;
  const isUnavailable = !isLoading && projection.plansError !== null;

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "planDirectory.title" })}
        </h2>
        <PlanDirectorySortIndicator
          label={intl.formatMessage({ id: "planDirectory.sortByTime" })}
        />
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
              // 创建时间是「哪份最新」的第二条证据（第一条是目录按时间降序的位置）。
              // 缺失就整行不渲染，不留占位。
              const createdAt = formatPlanCreatedAt({
                createdAt: item.createdAt,
                formatMessage: intl.formatMessage,
                locale,
              });
              return (
                <li key={item.planId}>
                  <button
                    type="button"
                    data-plan-directory-plan-id={item.planId}
                    data-plan-directory-created-at={item.createdAt}
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
                      {createdAt ? (
                        <span
                          className="mt-0.5 block text-ui-sm text-foreground-subtlest"
                          title={createdAt.title}
                        >
                          {createdAt.label}
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
