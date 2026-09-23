import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { EditorInfo } from "@zcode/shared";
import { CopyIcon, Ellipsis, ExternalLinkIcon, NotepadTextIcon } from "lucide-react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import {
  extractPlanToolCallContent,
  getPlanDirectoryTitle,
  getPlanPathLabel,
  stripLeadingPlanTitleHeading,
} from "@/lib/planToolCall.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import type { PlanDetailSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";

interface PlanDetailContent {
  markdown: string;
  planFilePath?: string;
  title?: string;
}

/** 打开时冻结的兜底值：投影窗口里找不到那条工具行时（会话滚远、冷启动）头部不至于空掉。 */
function readTabPlanContent(tab: PlanDetailSidePaneTab): PlanDetailContent {
  return {
    markdown: tab.markdown,
    ...(tab.planFilePath ? { planFilePath: tab.planFilePath } : {}),
    ...(tab.title ? { title: tab.title } : {}),
  };
}

const PlanDetailContent = memo(function PlanDetailContent({
  tab,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: {
  tab: PlanDetailSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}) {
  const { layer } = useV4Conversation();
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const fileActions = useFileContextActions();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const [lastContent, setLastContent] = useState<PlanDetailContent>(() => readTabPlanContent(tab));
  const [installedEditors, setInstalledEditors] = useState<EditorInfo[]>([]);
  const [preferredEditorId] = useState<string | null>(() => readLastSelectedEditorId());
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );

  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);

  // 头部优先用父会话投影里的实时值；投影缺席时才退回打开时冻结的 tab 字段。
  const liveContent = useMemo(() => {
    const row = state.snapshot?.rows.window.find(
      (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === tab.toolCallId,
    );
    if (!row || row.kind !== "toolCall") return undefined;
    const node = toolCallRowToLegacyNode(row);
    const content = extractPlanToolCallContent(node.toolCall, tab.workspacePath);
    if (!content.markdown) return undefined;
    return {
      markdown: content.markdown,
      ...(content.planFilePath ? { planFilePath: content.planFilePath } : {}),
      ...(content.title ? { title: content.title } : {}),
    };
  }, [state.snapshot, tab.toolCallId, tab.workspacePath]);

  useEffect(() => {
    if (liveContent) setLastContent(liveContent);
  }, [liveContent]);
  useEffect(() => {
    // 实时值在场时不写冻结值，否则后跑的这条 effect 会把实时值当场覆盖回打开时的旧值。
    if (!liveContent && tab.markdown) setLastContent(readTabPlanContent(tab));
  }, [liveContent, tab.markdown, tab.planFilePath, tab.title]);

  const content = liveContent ?? lastContent;
  const markdown = content.markdown;
  // 与折叠卡、运行时 frontmatter 同一条优先级链：显式 title 优先，回退正文首个 H1/首个非空行。
  const title = content.title ?? (markdown ? getPlanDirectoryTitle(markdown) : undefined);
  // 头部已经渲染了标题，正文里与它同名的首个 H1 不再重复渲染。
  const body = stripLeadingPlanTitleHeading(markdown, title);
  const planFilePath = content.planFilePath;
  // 路径文本不再展示：planFilePath 只作右上「…」复制与「在编辑器中打开」的操作目标。
  // 相对路径在复制时现算，不渲染。
  const pathLabel = planFilePath ? getPlanPathLabel(planFilePath, tab.workspacePath) : undefined;

  useEffect(() => {
    let disposed = false;
    platform.getInstalledEditors().then(
      (editors) => {
        if (!disposed) setInstalledEditors(editors);
      },
      (error: unknown) => {
        logger.warn("[PlanDetail] 获取已安装编辑器列表失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      disposed = true;
    };
  }, [platform]);

  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { workspaceRemoteSessionId: tab.remoteSessionId } : {}),
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  // 远程工作区解不出可用编辑器时不能退回本机编辑器：那会把远端路径交给人当成路径打开。
  const isRemoteWorkspace = Boolean(
    tab.workspaceIdentity || tab.remoteSessionId || matchedOpenContext.isRemoteWorkspace,
  );
  const selectedEditor = useMemo(
    () =>
      resolveWorkspaceEditorSelection({
        installedEditors: isRemoteWorkspace && !openInEditorRemoteTarget ? [] : installedEditors,
        selectedEditorId: preferredEditorId,
        remoteTarget: openInEditorRemoteTarget,
      }).selectedEditor,
    [installedEditors, isRemoteWorkspace, openInEditorRemoteTarget, preferredEditorId],
  );
  const openInEditorLabel = selectedEditor
    ? intl.formatMessage({ id: "appHeader.openInEditor" }, { editor: selectedEditor.name })
    : intl.formatMessage({ id: "chat.changeSummary.openInEditor" });

  const handleCopyPath = useCallback(
    (relative: boolean) => {
      if (!planFilePath) return;
      // 复制失败在 useFileContextActions 里只落日志，不会抛；不先挡掉没有剪贴板的场合，
      // 下面那条「已复制路径」就成了假的成功提示。
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        logger.warn("[PlanDetail] 复制计划文件路径失败", {
          error: "clipboard-unavailable",
          path: planFilePath,
        });
        return;
      }
      if (relative) {
        void fileActions.copyRelativePath({
          path: planFilePath,
          relativePath: pathLabel ?? planFilePath,
        });
      } else {
        void fileActions.copyAbsolutePath({ path: planFilePath });
      }
      toast(intl.formatMessage({ id: "planTool.panel.pathCopied" }));
    },
    [fileActions, intl, planFilePath, pathLabel],
  );

  const handleOpenInEditor = useCallback(() => {
    if (!planFilePath || !selectedEditor) return;
    void platform
      .openInEditor(selectedEditor.id, planFilePath, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: tab.workspaceIdentity,
      })
      .then(
        (result) => {
          if (result.success) return;
          // 远程目标或编辑器缺失会让 main 侧失败；只记日志，不在面板里弹错误条。
          logger.warn("[PlanDetail] 用编辑器打开计划文件失败", {
            editorId: selectedEditor.id,
            error: result.error ?? "unknown-error",
            path: planFilePath,
          });
        },
        (error: unknown) => {
          logger.warn("[PlanDetail] 打开计划文件失败", {
            error: error instanceof Error ? error.message : String(error),
            path: planFilePath,
          });
        },
      );
  }, [openInEditorRemoteTarget, planFilePath, platform, selectedEditor, tab.workspaceIdentity]);

  return (
    // 头部固定、正文独立滚动：用 flex 分栏而不是 sticky——根节点自己就是滚动容器，
    // sticky 会和 markdown 的 margin 折叠打架。
    <div
      data-plan-detail-tool-call-id={tab.toolCallId}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <NotepadTextIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-foreground-subtle"
            />
            <span className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "planTool.panel.planTab" })}
            </span>
            {/* 标题行右侧操作区：路径文本不再展示，planFilePath 只作这两个按钮的操作目标。
                无路径时整组缺席，不留空位。 */}
            {planFilePath ? (
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-foreground-subtle hover:text-foreground"
                      aria-label={intl.formatMessage({ id: "planTool.panel.pathActions" })}
                      title={intl.formatMessage({ id: "planTool.panel.pathActions" })}
                    >
                      <Ellipsis aria-hidden="true" className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onSelect={() => handleCopyPath(false)}>
                      <CopyIcon className="size-4" />
                      {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => handleCopyPath(true)}>
                      <CopyIcon className="size-4" />
                      {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle hover:text-foreground disabled:text-foreground-subtlest"
                  aria-label={openInEditorLabel}
                  title={openInEditorLabel}
                  disabled={!selectedEditor}
                  onClick={handleOpenInEditor}
                >
                  <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>
          {/* 标题独立降级：字段缺席就不渲染这一行，不留空行。概述不在这里渲染，
              它只在折叠卡上出现（3 行截断），正文自己会讲到它说的那件事。 */}
          {title ? (
            <h2 className="break-words text-ui-lg font-medium text-foreground">{title}</h2>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <MessageResponse
          className="mx-auto w-full max-w-4xl min-w-0 break-words text-foreground"
          workspacePath={tab.workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {body}
        </MessageResponse>
      </div>
    </div>
  );
});

export const PlanDetailSidePane = memo(function PlanDetailSidePane({
  tab,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: {
  tab: PlanDetailSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
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
    // provider 接口已收敛为仅按 scope 做连接路由，不再接受
    // isShellWorkspace 参数；side pane 不需要额外的 shell 身份分支。
    <V4PaneConversationProvider scope={scope}>
      <PlanDetailContent
        tab={tab}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
      />
    </V4PaneConversationProvider>
  );
});
