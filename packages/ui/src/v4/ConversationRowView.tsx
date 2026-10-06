import { formatModelChangeThoughtLabel } from "@/v4/modelChangeThoughtLabel.js";
/* oxlint-disable eslint(max-lines) -- v4 逐行 row 渲染分发集中收口（每种 row 一个 memo 叶子 + timelineMarker 分隔线），拆分会打散行类型对照。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  CopyIcon,
  FileIcon,
  GitBranchIcon,
  GoalIcon,
  PencilIcon,
  TrendingUpDownIcon,
  XIcon,
} from "lucide-react";
import {
  TID_V4_EDIT,
  TID_V4_EDIT_ATTACHMENT_REMOVE,
  TID_V4_EDIT_CANCEL,
  TID_V4_EDIT_INPUT,
  TID_V4_EDIT_SUBMIT,
  TID_V4_EDIT_SUBMIT_REJECTED,
  TID_V4_EDIT_UNDO_CONFIRM,
  TID_V4_EDIT_UNDO_CONFIRM_DIALOG,
  TID_V4_EDIT_UNDO_CONFIRM_KEEP_FILES,
  TID_V4_FORK,
  TID_V4_ROW,
  TID_V4_ROW_ATTACHMENTS,
  testId,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type {
  SessionConfigState,
  AttachmentRef,
  ArtifactRow,
  AssistantTextRow,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  HookInvocationRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { completeNewModelSelection } from "@zcode/provider";
import { V4ComposerModelControls } from "@/v4/composer/V4ComposerToolbar.js";
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import {
  isConversationReasoningRowVisible,
  V4EditControlsRuntimeContext,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import { resolveEditFileRewindDialogDecision } from "@/v4/conversationEditFileRewindDialog.js";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { PdfViewerRangeSource } from "@/components/ui/pdf-viewer.js";
import {
  MessageAction,
  MessageActions,
  MessageResponse,
} from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import { readWorkflowName } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { isAmendWorkflowToolCall } from "@/lib/workflowToolNames.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { writeTextToClipboard } from "@/lib/clipboard.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import {
  FileDisplayIcon,
  FileDisplayInline,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import {
  countComposerPromptContexts,
  parseComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import {
  ConversationUserInputEpilogue,
  splitUserInputEpilogue,
} from "@/v4/ConversationUserInputEpilogue.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";

import { formatMessageTimeLabel } from "@/v4/messageTimeLabel.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";

function RowShell({
  rowId,
  children,
  className = "",
}: {
  rowId: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-row-id={rowId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={cn(className)}
    >
      {children}
    </div>
  );
}

const ArtifactRowView = memo(function ArtifactRowView({ row }: { row: ArtifactRow }) {
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
        <FileIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base text-foreground">{row.displayName}</p>
          <p className="text-ui-sm text-foreground-subtle">
            {row.artifactType.toUpperCase()} · {row.sizeBytes} bytes
          </p>
        </div>
      </div>
    </RowShell>
  );
});

/** 复制行文本：图标 ghost 按钮 + 1200ms 打勾态（对齐旧版 message copy）。
 *  label/tooltip 必须由调用方传入 i18n 文案，禁止硬编码语言。 */
const CopyRowAction = memo(function CopyRowAction({
  text,
  rowId,
  label,
  tooltip = label,
}: {
  text: string;
  rowId: number;
  label: string;
  tooltip?: string;
}) {
  const { intl } = useZCodeIntl();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!text) return;
    // 失败必须让用户看见：runUserActionAsync 失败时是 re-throw 的，
    // 不挂 .catch() 的话既不打勾也不提示，表现为「点了没反应」。
    void runUserActionAsync({
      input: { featureId: "conversation.history.feedback", action: "copy", trigger: "button" },
      operation: () => writeTextToClipboard(text),
      completed: { resultSource: "platform_result" },
      failureStage: "clipboard_write",
    })
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((error: unknown) => {
        toast(
          intl.formatMessage(
            { id: "chat.message.copy.failed" },
            { error: error instanceof Error ? error.message : String(error) },
          ),
        );
      });
  }, [intl, text]);
  return (
    <MessageAction
      aria-label={label}
      label={label}
      tooltip={tooltip}
      data-testid={`v4-copy-${rowId}`}
      disabled={text.length === 0}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
});

/**
 * 编辑重发的执行参数覆盖（specs/message-history-edit.md 规则 5-7）。
 * 字段缺省 undefined = CLI 继承目标轮当年 admission 冻结值；编辑卡的控件
 * 初始值即当年值，用户未改动时提交与旧行为等价。
 */
export interface EditExecutionOverrides {
  mode?: UserInputRow["admissionMode"];
  modelSelection?: UserInputRow["admissionModelSelection"];
  // 文件回滚冲突策略（specs/message-history-edit.md 规则 26）：仅 workspaceMode=rewind
  // 且冲突弹窗选择「仍然恢复文件并重发」时传 overwrite；缺省 block=现状兜底。
  fileRewindConflict?: "block" | "overwrite";
}

type UserInputEditHandler = (
  target: ConversationRowTarget,
  newText: string,
  attachments?: readonly AttachmentRef[],
  workspaceMode?: "preserve" | "rewind",
  overrides?: EditExecutionOverrides,
) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;

type AssistantMessageFeedback = "like" | "dislike";

function getAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

export type AssistantFeedbackHandler = (
  target: ConversationRowTarget,
  feedback: AssistantMessageFeedback | null,
) => Promise<boolean | void> | boolean | void;

export function readAssistantFeedback(row: AssistantTextRow): AssistantMessageFeedback | null {
  // feedback 是 additive V4 row 字段；兼容旧 CLI 的 row 时缺省为 null。
  const feedback = row.feedback;
  return feedback === "like" || feedback === "dislike" ? feedback : null;
}

/**
 * 中间轮编辑的 Undo 确认弹窗（specs/message-history-edit.md 规则 15-16）：确认前
 * 完整时间线（含弱化预览）仍在视野内，是唯一反悔窗口；确认后 Undo（截断）与
 * Send（重发）连续原子执行，无「只 Undo 不 Send」的中间态。
 * 传入 preview（rewind 提交且编辑点之后有可恢复文件）时切换为文件清单 +
 * 双动作形态（规则 25）：含文件恢复 / 不动文件平级。
 */
function EditTruncateConfirmDialog({
  open,
  onOpenChange,
  truncateTurns,
  submitting,
  preview,
  onConfirm,
  onConfirmKeepFiles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  truncateTurns: number;
  submitting: boolean;
  /** withFiles 形态的文件预览；undefined = 纯对话 Undo 弹窗（规则 24 无文件态）。 */
  preview?: V4ConversationFileRewindPreviewResult | null;
  onConfirm: () => void;
  /** 仅 preview 形态使用：撤销并重发但不动文件（等价 preserve 提交）。 */
  onConfirmKeepFiles?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const showFiles = Boolean(preview && preview.safeFiles.length > 0);
  // 规则 40：末轮编辑也走确认窗。末轮没有截断轮数，description 改述重发后果
  // （丢弃当前回复重新生成）；中间轮保持「将删除 N 轮」口径。
  const descriptionId =
    truncateTurns > 0
      ? "chat.edit.undoConfirm.description"
      : "chat.edit.undoConfirm.descriptionLastTurn";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={TID_V4_EDIT_UNDO_CONFIRM_DIALOG} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "chat.edit.undoConfirm.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: descriptionId },
              { count: truncateTurns },
            )}
          </DialogDescription>
        </DialogHeader>
        {showFiles ? (
          <div className="grid gap-1">
            <h3 className="text-ui-base font-medium">
              {intl.formatMessage(
                { id: "chat.edit.undoConfirm.filesTitle" },
                { count: String(preview!.safeFiles.length) },
              )}
            </h3>
            <div className="grid max-h-40 gap-1 overflow-y-auto pr-1">
              {preview!.safeFiles.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-input/30 px-2 py-1.5"
                >
                  <span className="min-w-0 truncate font-mono text-ui-xs text-foreground">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-ui-xs text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "chat.changeSummary.rewindDialog.operationCount" },
                      { count: String(file.operationCount) },
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          {showFiles && onConfirmKeepFiles ? (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              data-testid={TID_V4_EDIT_UNDO_CONFIRM_KEEP_FILES}
              onClick={onConfirmKeepFiles}
            >
              {intl.formatMessage({ id: "chat.edit.undoConfirm.confirmKeepFiles" })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="destructive"
            disabled={submitting}
            data-testid={TID_V4_EDIT_UNDO_CONFIRM}
            onClick={onConfirm}
          >
            {intl.formatMessage({
              id: showFiles
                ? "chat.edit.undoConfirm.confirmWithFiles"
                : "chat.edit.undoConfirm.confirm",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConversationRowViewProps {
  row: ConversationRow;
  /** 渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  context: ConversationRowRenderContext;
  /** 完成态 assistant 行的 fork 入口（forkAssistant command）。 */
  onFork?: (target: ConversationRowTarget) => void;
  /** assistant entity 反馈 CAS；UI 先乐观更新，命令失败时回滚。 */
  onFeedbackChange?: AssistantFeedbackHandler;
  /** 协议兼容：上层仍可提供 retryTurn capability，但产品 UI 不渲染普通重试入口。 */
  onRetry?: (target: ConversationRowTarget) => void;
  /** user 行的 edit 入口（editUserQuery command，用行内编辑文本替换该轮）。 */
  onEdit?: UserInputEditHandler;
  /** 嵌套在工具 Group 内时去掉 Reasoning 内容的重复左导线与缩进。 */
  reasoningContentVariant?: "default" | "nested";
  /** renderer-only 提交状态；不写入协议 row，也不冒充已 drain 的历史事实。 */
  userInputStatus?: string;
  /**
   * 一轮对用户是一个回复：非最后一段 text 不显示任何
   * action（复制/fork 都没有），入口只在轮尾段。
   */
  hideAssistantActions?: boolean;
  /** TurnGroup 需要把轮级 action 延后到文件 summary 后渲染。 */
  deferAssistantActions?: boolean;
  /** 轮尾段的复制内容 = 整轮全部 text 段合并（不是只复制最后一段）。 */
  assistantCopyText?: string;
  /** Assistant Preview Cards 只由 TurnGroup 为轮尾 terminal assistant text 计算后下发。 */
  assistantPreviewCards?: AssistantPreviewCard[];
  /** 仅当前 renderer 观察到 running -> complete 时下发的一次性自动打开身份。 */
  assistantPreviewCardsAutoOpenKey?: string;
  /** Assistant code-comment cards 只由 TurnGroup 为轮尾终态 assistant text 计算后下发。 */
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  /** 由 TurnGroup 统一裁决整轮正文是否隐藏 code-comment 协议原文。 */
  assistantCodeCommentProjectionEnabled?: boolean;
}

// ── 每种行拆成独立 memo 叶子：虚拟列表下父级重渲染时，只有 props 真变的行重渲染；
// 需要 hook 的行类型（assistantText/toolCall）hook 调用留在各自组件内，避免
// switch 分发组件里出现条件 hook。──

/**
 * 附件渲染：row 仍只保存 AttachmentRef；图片挂载时按 session/ref 分块读取缩略图，点击后复用已加载 URL 进入共享预览。
 * 非图片与失败后的图片保持纯展示，避免无动作的假手型。
 */
const UserInputAttachmentList = memo(function UserInputAttachmentList({
  attachments,
  attachmentIndices,
  entityId,
  attachmentKind = "all",
  directItems = false,
  onRemove,
  rowId,
  sessionId,
  readAttachment,
  readAttachmentRange,
}: {
  attachments: readonly AttachmentRef[] | undefined;
  /** 编辑态删除附件后仍保留其在持久 FilePart 列表中的原序号。 */
  attachmentIndices?: readonly number[];
  entityId?: string;
  attachmentKind?: "all" | "media" | "file";
  directItems?: boolean;
  onRemove?: (index: number) => void;
  rowId: number;
  sessionId?: string;
  readAttachment?: NonNullable<ConversationRowRenderContext["readAttachment"]>;
  readAttachmentRange?: NonNullable<ConversationRowRenderContext["readAttachmentRange"]>;
}) {
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [failedRefs, setFailedRefs] = useState<ReadonlySet<string>>(() => new Set());
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  // 可见消息行预取 image/video Blob：图片直接显示，视频由无控件播放器展示首帧；
  // video URL 同时供 gallery 复用，避免用户点击后再次读取大文件。
  const [videoPreview, setVideoPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [videoPreviewRef, setVideoPreviewRef] = useState<string | null>(null);
  const [videoPreviewLoading, setVideoPreviewLoading] = useState(false);
  const [videoPreviewError, setVideoPreviewError] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);
  const [pdfPreviewError, setPdfPreviewError] = useState(false);
  const [pdfPreviewRef, setPdfPreviewRef] = useState<string | null>(null);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestRef = useRef(0);
  const pdfPreviewAbortRef = useRef<AbortController | null>(null);
  const videoPreviewUrlRef = useRef<string | null>(null);
  const videoPreviewRequestRef = useRef(0);
  const videoPreviewAbortRef = useRef<AbortController | null>(null);
  const thumbnailUrlsRef = useRef<Map<string, string>>(new Map());
  const thumbnailObjectUrlsRef = useRef<Set<string>>(new Set());
  const previewOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const previewVideoOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const previewPdfOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openPdf",
  });
  const previewUnavailableLabel = intl.formatMessage({
    id: "chat.attachments.preview.unavailable",
  });

  useEffect(() => {
    if (attachmentKind === "file" || !attachments || !sessionId || !readAttachment) {
      return;
    }
    let cancelled = false;
    // 只丢弃读取结果不会停止底层分块传输，消息行卸载后仍可能拉取完整视频。
    // 预取生命周期必须通过 AbortSignal 贯穿 transport，及时释放文件 IO 与 IPC 资源。
    const controller = new AbortController();
    const mediaAttachments = attachments.flatMap((attachment, index) =>
      attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/")
        ? [{ attachment, index }]
        : [],
    );

    // V4 虚拟列表只挂载可见行，避免扫描整段历史。视频仍使用稳定 row target，
    // 保证同一路径多次发送时缩略图来自当前消息的 durable artifact。
    void Promise.all(
      mediaAttachments.map(async ({ attachment, index }) => {
        const ref = attachment.previewRef ?? attachment.ref;
        const isVideo = attachment.mime.startsWith("video/");
        try {
          const result = await readAttachment({
            sessionId,
            ref,
            signal: controller.signal,
            ...(isVideo ? { mediaType: attachment.mime } : {}),
            ...(isVideo && entityId
              ? {
                  target: { rowId, entityId },
                  attachmentIndex: attachmentIndices?.[index] ?? index,
                }
              : {}),
          });
          if (cancelled) return;
          const isLocalUrl = "url" in result;
          const url = isLocalUrl
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], {
                  type: result.mediaType,
                }),
              );
          if (!isLocalUrl) thumbnailObjectUrlsRef.current.add(url);
          if (cancelled) {
            if (!isLocalUrl) {
              thumbnailObjectUrlsRef.current.delete(url);
              URL.revokeObjectURL(url);
            }
            return;
          }
          thumbnailUrlsRef.current.set(ref, url);
          setThumbnailUrls(new Map(thumbnailUrlsRef.current));
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          if (!isVideo) setFailedRefs((current) => new Set(current).add(ref));
          logger.warn(
            `[v4-attachment-preview] failed to read sent ${isVideo ? "video" : "image"} thumbnail`,
            error,
          );
        }
      }),
    );

    return () => {
      controller.abort();
      cancelled = true;
      // Desktop local video 返回自定义协议 URL，不是 renderer 创建的 Blob；
      // 只释放本 effect 创建的 object URL，避免把本地媒体 URL 当成 Blob 生命周期管理。
      for (const url of thumbnailObjectUrlsRef.current) URL.revokeObjectURL(url);
      thumbnailObjectUrlsRef.current.clear();
      thumbnailUrlsRef.current.clear();
    };
  }, [attachmentIndices, attachmentKind, attachments, entityId, readAttachment, rowId, sessionId]);

  // ── sent video 预览读取：staging 语义原样保留 ──
  const releaseVideoPreviewUrl = useCallback(() => {
    if (!videoPreviewUrlRef.current) return;
    URL.revokeObjectURL(videoPreviewUrlRef.current);
    videoPreviewUrlRef.current = null;
  }, []);

  const cancelVideoPreviewRead = useCallback(() => {
    videoPreviewRequestRef.current += 1;
    videoPreviewAbortRef.current?.abort();
    videoPreviewAbortRef.current = null;
  }, []);

  useEffect(
    () => () => {
      cancelVideoPreviewRead();
      releaseVideoPreviewUrl();
    },
    [cancelVideoPreviewRead, releaseVideoPreviewUrl],
  );

  const closeVideoPreview = useCallback(() => {
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
  }, [cancelVideoPreviewRead, releaseVideoPreviewUrl]);

  const closePdfPreview = useCallback(() => {
    pdfPreviewRequestRef.current += 1;
    pdfPreviewAbortRef.current?.abort();
    pdfPreviewAbortRef.current = null;
    if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
    pdfPreviewUrlRef.current = null;
    setPdfPreview(null);
    setPdfPreviewRef(null);
    setPdfPreviewLoading(false);
    setPdfPreviewError(false);
  }, []);

  useEffect(
    () => () => {
      closePdfPreview();
    },
    [closePdfPreview],
  );

  const openVideoPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number, galleryIndex: number) => {
      if (!sessionId || !readAttachment) return;
      const ref = attachment.previewRef ?? attachment.ref;
      cancelVideoPreviewRead();
      const thumbnailUrl = thumbnailUrlsRef.current.get(ref);
      if (thumbnailUrl) {
        releaseVideoPreviewUrl();
        setPreviewIndex(galleryIndex);
        setPreviewOpen(true);
        setVideoPreviewRef(ref);
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        });
        setVideoPreviewLoading(false);
        setVideoPreviewError(false);
        return;
      }
      const requestId = videoPreviewRequestRef.current;
      const abortController = new AbortController();
      videoPreviewAbortRef.current = abortController;
      releaseVideoPreviewUrl();
      setPreviewIndex(galleryIndex);
      setPreviewOpen(true);
      setVideoPreviewRef(ref);
      setVideoPreview({
        filename: attachment.fileName,
        mediaType: attachment.mime,
      });
      setVideoPreviewLoading(true);
      setVideoPreviewError(false);
      try {
        const result = await readAttachment({
          sessionId,
          ref,
          mediaType: attachment.mime,
          // 有 entityId 时按稳定 row target 精确读取；否则退回按 ref 匹配。
          ...(entityId ? { target: { rowId, entityId }, attachmentIndex } : {}),
          signal: abortController.signal,
        });
        if (videoPreviewRequestRef.current !== requestId) return;
        const isLocalUrl = "url" in result;
        const url = isLocalUrl
          ? result.url
          : URL.createObjectURL(
              new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
            );
        if (videoPreviewRequestRef.current !== requestId) {
          if (!isLocalUrl) URL.revokeObjectURL(url);
          return;
        }
        videoPreviewUrlRef.current = isLocalUrl ? null : url;
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (videoPreviewRequestRef.current !== requestId) return;
        // 一次 read 失败曾永久禁用附件入口，把可否打开 Dialog 错绑到读取结果。
        // 失败只属于本次预览；保留入口，让每次打开都重新读取并在 Dialog 内展示错误。
        setVideoPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent media", error);
      } finally {
        if (videoPreviewRequestRef.current === requestId) {
          videoPreviewAbortRef.current = null;
          setVideoPreviewLoading(false);
        }
      }
    },
    [cancelVideoPreviewRead, entityId, readAttachment, releaseVideoPreviewUrl, rowId, sessionId],
  );

  const openPdfPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number) => {
      if (!sessionId || (!readAttachment && !readAttachmentRange)) return;
      const ref = attachment.previewRef ?? attachment.ref;
      pdfPreviewRequestRef.current += 1;
      const requestId = pdfPreviewRequestRef.current;
      pdfPreviewAbortRef.current?.abort();
      const abortController = new AbortController();
      pdfPreviewAbortRef.current = abortController;
      if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
      setPdfPreviewRef(ref);
      setPdfPreview({ filename: attachment.fileName, mediaType: "application/pdf" });
      setPdfPreviewLoading(true);
      setPdfPreviewError(false);
      try {
        const target = entityId ? { target: { rowId, entityId }, attachmentIndex } : {};
        if (readAttachmentRange) {
          const firstRange = await readAttachmentRange({
            sessionId,
            ref,
            ...target,
            offset: 0,
            limit: 256 * 1024,
            signal: abortController.signal,
          });
          const source: PdfViewerRangeSource = {
            totalBytes: firstRange.totalBytes,
            initialData: firstRange.bytes,
            requestRange: async (offset, limit) => {
              const range = await readAttachmentRange({
                sessionId,
                ref,
                ...target,
                offset,
                limit,
                signal: abortController.signal,
              });
              return range.bytes;
            },
          };
          if (pdfPreviewRequestRef.current !== requestId) return;
          setPdfPreview({
            filename: attachment.fileName,
            mediaType: firstRange.mediaType,
            pdfSource: source,
          });
          return;
        }
        if (!readAttachment) return;
        const result = await readAttachment({
          sessionId,
          ref,
          ...target,
          signal: abortController.signal,
        });
        if (pdfPreviewRequestRef.current !== requestId) return;
        const url =
          "url" in result
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
              );
        if (!("url" in result)) pdfPreviewUrlRef.current = url;
        setPdfPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (pdfPreviewRequestRef.current !== requestId) return;
        setPdfPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent PDF", error);
      } finally {
        if (pdfPreviewRequestRef.current === requestId) {
          pdfPreviewAbortRef.current = null;
          setPdfPreviewLoading(false);
        }
      }
    },
    [entityId, readAttachment, readAttachmentRange, rowId, sessionId],
  );

  const visibleAttachments = (attachments ?? [])
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => {
      if (attachmentKind === "all") return true;
      const isMedia = attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/");
      return attachmentKind === "media" ? isMedia : !isMedia;
    });
  if (attachmentKind === "all") {
    // 行内编辑器过去直接沿用只读消息的通用附件列表，既没有按输入框的
    // “媒体 → 文件”视觉顺序排列，也误用了已发送消息的 pill。排序只改变渲染顺序，
    // index 仍指向原数组，避免删除后提交错误的附件。
    visibleAttachments.sort(
      ({ attachment: left }, { attachment: right }) =>
        Number(right.mime.startsWith("image/") || right.mime.startsWith("video/")) -
        Number(left.mime.startsWith("image/") || left.mime.startsWith("video/")),
    );
  }
  if (visibleAttachments.length === 0) return null;
  const previewEntries = (attachments ?? []).flatMap((attachment, index) => {
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    if (!isImage && !isVideo) return [];
    const ref = attachment.previewRef ?? attachment.ref;
    const src = thumbnailUrls.get(ref);
    if (isImage && !src) return [];
    return [
      {
        attachment,
        index,
        persistedAttachmentIndex: attachmentIndices?.[index] ?? index,
      },
    ];
  });
  const previewItems = previewEntries.map(({ attachment }) => {
    const ref = attachment.previewRef ?? attachment.ref;
    const isVideo = attachment.mime.startsWith("video/");
    return {
      alt: attachment.fileName,
      filename: attachment.fileName,
      mediaType: attachment.mime,
      src: isVideo && videoPreviewRef === ref ? videoPreview?.url : thumbnailUrls.get(ref),
      loading: isVideo && videoPreviewRef === ref && videoPreviewLoading,
      error: isVideo && videoPreviewRef === ref && videoPreviewError,
    };
  });
  const selectPreviewItem = (galleryIndex: number) => {
    const entry = previewEntries[galleryIndex];
    if (!entry) return;
    if (entry.attachment.mime.startsWith("video/")) {
      void openVideoPreview(entry.attachment, entry.persistedAttachmentIndex, galleryIndex);
      return;
    }
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
    setPreviewIndex(galleryIndex);
    setPreviewOpen(true);
  };
  const items = visibleAttachments.map(({ attachment, index }) => {
    const ref = attachment.previewRef ?? attachment.ref;
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    const isPdf = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    const isMedia = isImage || isVideo;
    const isEditingAttachment = attachmentKind === "all";
    const isThumbnail = attachmentKind === "media" || (isEditingAttachment && isMedia);
    const fileDisplayDescriptor = resolveFileDisplayDescriptor(attachment.fileName);
    const isUnavailable = failedRefs.has(ref);
    const thumbnailUrl = thumbnailUrls.get(ref) ?? "";
    const previewItemIndex = previewEntries.findIndex((entry) => entry.index === index);
    // 图片与视频共用当前消息的媒体 gallery；video 首次成为 active item 时再读取。
    const canOpen =
      (isImage && !isUnavailable && previewItemIndex >= 0) ||
      (isVideo && Boolean(sessionId && readAttachment)) ||
      (isPdf && Boolean(sessionId && (readAttachment || readAttachmentRange)));
    return (
      <Attachment
        key={`${attachment.ref}-${index}`}
        variant={isThumbnail ? "grid" : "inline"}
        data-v4-user-edit-attachment-kind={
          isEditingAttachment
            ? isImage
              ? "image"
              : isVideo
                ? "video"
                : isPdf
                  ? "pdf"
                  : "file"
            : undefined
        }
        data-v4-user-input-attachment-pill={isThumbnail ? undefined : "true"}
        data-v4-user-input-media-attachment={isThumbnail ? "true" : undefined}
        className={cn(
          isThumbnail &&
            (isEditingAttachment
              ? "relative size-12 overflow-hidden rounded-lg bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-[''] hover:bg-surface-hover"
              : "relative size-20 overflow-hidden rounded-xl bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-border after:content-[''] hover:bg-surface-hover"),
          !isThumbnail &&
            (isEditingAttachment
              ? "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
              : "rounded-full border-0 bg-surface px-3 py-1.5 hover:bg-surface-hover"),
        )}
        onRemove={onRemove ? () => onRemove(index) : undefined}
        onOpen={
          canOpen
            ? () =>
                isPdf
                  ? void openPdfPreview(attachment, attachmentIndices?.[index] ?? index)
                  : selectPreviewItem(previewItemIndex)
            : undefined
        }
        openLabel={
          canOpen
            ? isVideo
              ? previewVideoOpenLabel
              : isPdf
                ? previewPdfOpenLabel
                : previewOpenLabel
            : undefined
        }
        title={isUnavailable ? previewUnavailableLabel : undefined}
        data={{
          id: `${rowId}-${index}`,
          type: "file",
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        }}
      >
        {isThumbnail ? (
          <div className="relative size-full">
            <AttachmentPreview className="size-full rounded-none" />
          </div>
        ) : isEditingAttachment ? (
          <>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background">
              <FileDisplayIcon
                src={fileDisplayDescriptor.fileIconSrc}
                size={16}
                className="size-4 shrink-0"
              />
            </div>
            <div className="min-w-0 max-w-40 flex-1">
              <span
                className="block truncate text-ui-base font-medium text-foreground"
                title={attachment.fileName}
              >
                {attachment.fileName}
              </span>
              <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                {getAttachmentTypeLabel(attachment.fileName, attachment.mime)}
              </span>
            </div>
          </>
        ) : (
          <FileDisplayInline
            path={attachment.fileName}
            options={{
              className: "inline-flex min-w-0 max-w-40 items-center gap-1.5",
              iconSize: 16,
              fileNameClassName: "truncate text-ui-base font-medium text-foreground",
            }}
          />
        )}
        {onRemove && isEditingAttachment ? (
          <AttachmentRemove
            placement="corner"
            size="icon"
            variant="default"
            aria-label={intl.formatMessage({ id: "chat.attachments.remove" })}
            label={intl.formatMessage({ id: "chat.attachments.remove" })}
            data-testid={testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${rowId}-${index}`)}
            className="absolute top-0.5 right-0.5 z-10 size-3.5 rounded-full p-0 text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <XIcon className="size-2.5" />
          </AttachmentRemove>
        ) : null}
      </Attachment>
    );
  });
  return (
    <>
      {directItems ? (
        items
      ) : (
        <Attachments
          variant="inline"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(rowId))}
          className="max-w-full gap-2"
        >
          {items}
        </Attachments>
      )}
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onActiveIndexChange={selectPreviewItem}
        onOpenChange={(open) => {
          if (open) {
            setPreviewOpen(true);
            return;
          }
          setPreviewOpen(false);
          closeVideoPreview();
        }}
        open={previewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfPreview}
        open={pdfPreviewRef !== null}
        loading={pdfPreviewLoading}
        error={pdfPreviewError}
        onOpenChange={(open) => {
          if (!open) closePdfPreview();
        }}
      />
    </>
  );
});

const UserInputRowView = memo(function UserInputRowView({
  row,
  context,
  onEdit,
  status,
}: {
  row: UserInputRow;
  context: ConversationRowRenderContext;
  onEdit?: UserInputEditHandler;
  status?: string;
}) {
  const { intl } = useZCodeIntl();
  // 引擎尾注折叠：正文只到 epilogueStart，
  // 之后的引擎文本折进气泡底部的披露。提示词上下文解析也只看正文——尾注里没有用户引用。
  const { body: bodyText, epilogue } = splitUserInputEpilogue(row.text, row.epilogueStart);
  const parsedPrompt = useMemo(
    () =>
      parseComposerPromptContexts(bodyText, {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }),
    [bodyText, context.workspaceIdentity, context.workspacePath],
  );
  // 只用于把历史消息里的 share URL 尾块从可见正文里剥掉。
  // 该块已不再产出（见 ConversationComposer 的 promptText 注释）；这里保留解析，是为了让
  // 接线修复到本次删除之间发出的消息不至于把裸 markup 当正文显示出来。
  const parsedShareContext = useMemo(
    () => parseConversationShareContext(parsedPrompt.visibleContent),
    [parsedPrompt.visibleContent],
  );
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 规则 37：编辑提交被拒（ack rejected/stale）时置位，卡内行内提示；再提交或重开编辑卡即清除。
  // 存消息 id 而非布尔：ack 被拒（会话内容已更新）与连接中断（dispatch 抛错）文案不同。
  const [submitRejectedMessageId, setSubmitRejectedMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useState(row.text);
  // 规则 39：编辑卡 initialValue 在开卡时定格（停靠恢复或原文），编辑会话内不再随 props 漂移。
  const [editInitialValue, setEditInitialValue] = useState(() => parsedPrompt.visibleContent);
  // 规则 39：draftRef 供关闭时刻读取最新草稿（关闭路径的 effect 闭包不含 draft）；
  // draftBaseRef 记录开卡时的行原文；closeReasonRef 区分被动关闭（失焦/被顶掉/虚拟化
  // 卸载 → 停靠草稿）与显式取消/提交成功（丢弃），初始 discard 与挂载复位路径对齐。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftBaseRef = useRef(parsedShareContext.visibleContent);
  const closeReasonRef = useRef<"auto" | "discard">("discard");
  const [editAttachments, setEditAttachments] = useState<AttachmentRef[]>(() => [
    ...(row.attachments ?? []),
  ]);
  // 编辑态删除附件后，持久 FilePart 列表仍保留全部附件；序号数组把可见列表
  // 映射回原 index，避免 video 预览等按 attachmentIndex 的读取指错分块。
  const [editAttachmentIndices, setEditAttachmentIndices] = useState<number[]>(() =>
    (row.attachments ?? []).map((_, index) => index),
  );
  const [editPromptContexts, setEditPromptContexts] = useState(() => parsedPrompt);
  const [conflictPreview, setConflictPreview] =
    useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  // 编辑重发的执行参数覆盖（specs/message-history-edit.md 规则 5-7）：初始值即
  // 该轮当年 admission 冻结值；中间轮提交时先经 Undo 确认弹窗（pendingSubmit 暂存）。
  const [editMode, setEditMode] = useState<UserInputRow["admissionMode"]>(() => row.admissionMode);
  const [editModelSelection, setEditModelSelection] = useState<
    UserInputRow["admissionModelSelection"]
  >(() => row.admissionModelSelection);
  // 编辑卡复用 composer 控制簇（V4ComposerModeSwitch / V4ComposerModelControls）：
  // 菜单互斥 owner 与 draft 投影；draft 只承载覆盖值，提交路径不变（规则 5/30）。
  const [editConfigPicker, setEditConfigPicker] = useState<V4ComposerConfigPicker | null>(null);
  const editDraftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({ mode: editMode ?? "ask", modelSelection: editModelSelection ?? undefined }),
    [editMode, editModelSelection],
  );
  const editControlsRuntime = useContext(V4EditControlsRuntimeContext);
  const editModelSelectionState: ModelSelectionState =
    editControlsRuntime?.modelSelectionState ??
    (context.modelSelectionView
      ? { status: "ready", view: context.modelSelectionView }
      : { status: "loading" });
  const handleEditSelectModel = useCallback(
    (providerId: string, modelId: string) => {
      setEditModelSelection((current) => {
        if (current?.providerId === providerId && current?.modelId === modelId) return current;
        const view = context.modelSelectionView;
        const completed = view ? completeNewModelSelection(view, { providerId, modelId }) : undefined;
        return completed ?? { providerId, modelId };
      });
    },
    [context.modelSelectionView],
  );
  const handleEditSelectThought = useCallback(
    (thought: string, modelContext: { provider: string; model: string }) => {
      setEditModelSelection((current) => {
        if (
          !current ||
          current.providerId !== modelContext.provider ||
          current.modelId !== modelContext.model
        ) {
          return current;
        }
        const { reasoningLevel: _dropped, ...restOptions } = current.options ?? {};
        return {
          ...current,
          ...(thought
            ? { options: { ...restOptions, reasoningLevel: thought } }
            : { options: { ...restOptions } }),
        };
      });
    },
    [],
  );
  const [undoConfirmOpen, setUndoConfirmOpen] = useState(false);
  // 规则 40（唯一提交入口）：workspaceMode 不再由工具条按钮预选，恒在弹窗动作上
  // 决定，暂存只携带文本。
  const [pendingSubmit, setPendingSubmit] = useState<{
    text: string;
  } | null>(null);
  // rewind 提交的 preview 弹窗三态判定结果（specs/message-history-edit.md 规则 23-26）：
  // conversationOnly 不进这个状态（直接弹纯对话 Undo）；withFiles 复用 Undo 弹窗的
  // 文件清单形态；conflict 走冲突弹窗。preview 失败置 null，降级为现有 Undo 弹窗。
  const [pendingFileRewind, setPendingFileRewind] = useState<{
    variant: "withFiles" | "conflict";
    allowOverwrite: boolean;
  } | null>(null);
  const [fileRewindPreview, setFileRewindPreview] =
    useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [fileRewindPreviewLoading, setFileRewindPreviewLoading] = useState(false);
  // 中间轮判定：投影在 actions 上给出的截断轮数（row 自包含，UI 不数轮）。
  const editTruncateTurns = row.actions?.editTruncateTurns ?? 0;
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const editContextCount = countComposerPromptContexts(editPromptContexts);
  const canSubmit = draft.trim().length > 0 || editAttachments.length > 0 || editContextCount > 0;
  const submitLabel = intl.formatMessage({ id: "chat.send" });
  const cancelLabel = intl.formatMessage({ id: "common.cancel" });
  const visibleText = parsedShareContext.visibleContent;
  const codeCommentContexts = parsedPrompt.codeComments;
  const webElementContexts = parsedPrompt.webElements;
  const pptxElementReferences = parsedPrompt.pptxElements;
  const conversationSelections = parsedPrompt.conversationSelections;
  // 白名单对象引用稳定化：context 的四个集合各自引用稳定，但每次行渲染都拼新对象会
  // 让 memo 气泡逐行重渲染。这里按集合引用 memo，集合不变则对象引用不变。
  const mentionWhitelist = useMemo(
    () => ({
      skillNames: context.knownSkillNames,
      subagentNames: context.knownSubagentNames,
      commandNames: context.knownCommandNames,
      sessionIds: context.knownSessionIds,
    }),
    [
      context.knownSkillNames,
      context.knownSubagentNames,
      context.knownCommandNames,
      context.knownSessionIds,
    ],
  );
  const hasAttachments = (row.attachments?.length ?? 0) > 0;
  const hasMediaAttachments =
    row.attachments?.some(
      (attachment) => attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasFileAttachments =
    row.attachments?.some(
      (attachment) =>
        !attachment.mime.startsWith("image/") && !attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasVisibleText = visibleText.trim().length > 0;
  // nudge 轮整条都是引擎文本：正文为空但气泡仍要画，里面只有那一枚披露。
  const hasBubble = hasVisibleText || epilogue !== undefined;
  const hasContextReferences =
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    conversationSelections.length > 0;
  const hasAttachmentArea = hasAttachments || hasContextReferences;
  const hasAttachmentPills = hasFileAttachments || hasContextReferences;
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath: context.workspacePath,
    workspaceIdentity: context.workspaceIdentity,
    remoteSessionId: context.workspaceRemoteSessionId,
    onOpenCodeViewer: context.onOpenCodeViewer,
  });

  useEffect(() => {
    if (!editing) {
      // 规则 39：被动关闭（失焦/被顶掉）不清文本草稿，其余卡片状态照常复位；
      // 显式取消/提交成功（discard）仍全量复位。
      if (closeReasonRef.current === "auto") {
        setEditAttachments([...(row.attachments ?? [])]);
        setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
        setEditPromptContexts(parsedPrompt);
        setEditMode(row.admissionMode);
        setEditModelSelection(row.admissionModelSelection);
        setUndoConfirmOpen(false);
        setPendingSubmit(null);
        setPendingFileRewind(null);
        setFileRewindPreview(null);
        return;
      }
      setDraft(parsedShareContext.visibleContent);
      setEditAttachments([...(row.attachments ?? [])]);
      setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
      setEditPromptContexts(parsedPrompt);
      setEditMode(row.admissionMode);
      setEditModelSelection(row.admissionModelSelection);
      setUndoConfirmOpen(false);
      setPendingSubmit(null);
      setPendingFileRewind(null);
      setFileRewindPreview(null);
      return;
    }
    const focusEditor = () => inputApiRef.current?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(focusEditor);
      return;
    }
    focusEditor();
  }, [editing, parsedPrompt, row.attachments]);

  useEffect(() => {
    if (!onEdit) {
      setEditing(false);
      setSubmitting(false);
    }
  }, [onEdit]);

  // 编辑卡开合通知宿主（specs/message-history-edit.md 规则 13）：宿主据此对其后
  // 时间线行做弱化预览并裁决单卡互斥。close 携带 rowId 交宿主做所有权校验。
  // hostConfirmedRef：宿主 state 已回流确认本卡为 owner（editingRowId === rowId）。
  const onEditCardOpenChange = context.onEditCardOpenChange;
  const contextParkEditDraft = context.parkEditDraft;
  const contextReadParkedEditDraft = context.readParkedEditDraft;
  const hostConfirmedRef = useRef(false);
  useEffect(() => {
    if (!onEditCardOpenChange) return;
    if (editing) onEditCardOpenChange(row.rowId, true);
    else {
      onEditCardOpenChange(row.rowId, false);
      hostConfirmedRef.current = false;
    }
    return () => {
      onEditCardOpenChange(row.rowId, false);
      // 规则 39：编辑卡关闭/卸载（含虚拟化卸载，此时本 effect 的 cleanup 是唯一
      // 收尾机会）按关闭原因处理半编辑草稿——被动关闭停靠待重开恢复，显式丢弃清除。
      if (!editing) return;
      if (closeReasonRef.current === "auto" && contextParkEditDraft) {
        contextParkEditDraft(row.rowId, { base: draftBaseRef.current, text: draftRef.current });
      } else {
        contextParkEditDraft?.(row.rowId, null);
      }
    };
  }, [editing, onEditCardOpenChange, contextParkEditDraft, row.rowId]);

  // 单卡互斥（规则 38）：宿主 editingRowId 被另一张编辑卡占用时，本卡自动退出。
  // 依赖宿主裁决而非行间直接通信，保证互斥状态只有一个所有者。
  // 竞态防护：本卡 setEditing(true) 的渲染先于宿主 state 回流（新卡打开瞬间
  // context 里还是旧卡的 rowId），此时互斥 effect 不得自关——等宿主确认后再裁决。
  const contextEditingRowId = context.editingRowId;
  useEffect(() => {
    if (editing && typeof contextEditingRowId === "number") {
      if (contextEditingRowId === row.rowId) {
        hostConfirmedRef.current = true;
      } else if (hostConfirmedRef.current) {
        setEditing(false);
      }
    }
  }, [editing, contextEditingRowId, row.rowId]);

  // 失焦退出（规则 38）：编辑态下点击卡片以外任意处即退出，与「可同时编辑多张卡」的
  // 旧行为一起移除。Radix 弹层（模型选择、tooltip、确认弹窗）挂在 body 直下的 portal，
  // 不属于卡片但也不算失焦——从 target 向上先碰到 #root 才视为落在应用内。
  useEffect(() => {
    if (!editing || submitting) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      let node: Element | null = target;
      while (node && node !== document.body) {
        if (node.id === "root") break;
        node = node.parentElement;
      }
      // 循环结束仍没碰到 #root：portal 内容或已脱离文档，不算失焦。
      if (!node || node === document.body) return;
      if (target.closest(`[data-row-id="${row.rowId}"]`)) return;
      setEditing(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [editing, submitting, row.rowId]);

  const handleOpenEdit = useCallback(() => {
    // v4 迁移时把 user query 编辑误接成“直接读取主 composer 提交”，
    // 主 composer 为空时点击只会 warn。这里恢复旧行内编辑态。
    // 规则 39：重开优先恢复停靠的半编辑草稿；base 与当前原文不一致（行内容已变，
    // 如上次提交成功后）则丢弃停靠，回到原文。开卡默认按被动关闭预期（auto）停靠。
    const parked = contextReadParkedEditDraft?.(row.rowId) ?? null;
    const parkedText =
      parked && parked.base === parsedShareContext.visibleContent ? parked.text : null;
    closeReasonRef.current = "auto";
    draftBaseRef.current = parsedShareContext.visibleContent;
    setDraft(parkedText ?? parsedShareContext.visibleContent);
    setEditInitialValue(parkedText ?? parsedPrompt.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditMode(row.admissionMode);
    setEditModelSelection(row.admissionModelSelection);
    setSubmitRejectedMessageId(null);
    setEditing(true);
  }, [
    contextReadParkedEditDraft,
    parsedPrompt,
    parsedShareContext,
    row.admissionMode,
    row.admissionModelSelection,
    row.attachments,
    row.rowId,
  ]);

  const handleCancelEdit = useCallback(() => {
    // 规则 39：显式取消是丢弃语义——清停靠草稿并复位卡片状态。
    closeReasonRef.current = "discard";
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditMode(row.admissionMode);
    setEditModelSelection(row.admissionModelSelection);
    setEditing(false);
  }, [
    parsedPrompt,
    parsedShareContext,
    row.admissionMode,
    row.admissionModelSelection,
    row.attachments,
  ]);

  const handleRemoveEditAttachment = useCallback((index: number) => {
    setEditAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setEditAttachmentIndices((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const handleSubmitEdit = useCallback(
    async (
      nextText: string,
      workspaceMode: "preserve" | "rewind" = "preserve",
      overrides?: EditExecutionOverrides,
    ) => {
      if (!onEdit) return;
      if (!nextText.trim() && editAttachments.length === 0 && editContextCount === 0) return;
      setSubmitRejectedMessageId(null);
      setSubmitting(true);
      try {
        const result = await onEdit(
          { rowId: row.rowId, entityId: row.entityId! },
          // 不再回写 share URL 尾块：它没有任何消费者，编辑历史消息时顺手清掉。
          serializeComposerPromptContexts(nextText, editPromptContexts),
          // 省略空数组会让 CLI 按 attachments 缺省语义恢复 canonical 原附件，
          // 因此 edit 必须始终提交当前完整列表，显式 [] 才能表达“删除全部”。
          editAttachments,
          workspaceMode,
          overrides,
        );
        if (
          typeof result === "object" &&
          result !== null &&
          result.result?.type === "editUserQuery" &&
          result.result.disposition === "blocked" &&
          result.result.preview
        ) {
          // 竞态兜底（specs/message-history-edit.md 规则 26）：提交时 preview 已变化
          // 被 CLI blocked。用返回的 preview 直接驱动冲突弹窗（含覆盖判定），
          // 与提交前 preview 弹窗共用同一套动作。
          const blockedPreview = result.result.preview;
          const decision = resolveEditFileRewindDialogDecision(blockedPreview);
          setFileRewindPreview(blockedPreview);
          setPendingFileRewind(
            decision.variant === "conversationOnly"
              ? null
              : {
                  variant: decision.variant,
                  allowOverwrite: decision.variant === "conflict" ? decision.allowOverwrite : false,
                },
          );
          setConflictPreview(blockedPreview);
          setConflictOpen(true);
          return;
        }
        if (result !== false) {
          // 规则 39：提交成功 = 丢弃语义，清除停靠（行原文已变，残留停靠也会被 base 校验拦下）。
          closeReasonRef.current = "discard";
          setEditing(false);
          setConflictOpen(false);
        } else {
          // 规则 37：被拒不静默（生产 renderer 日志 no-op，此前用户只看到「点了没反应」）。
          setSubmitRejectedMessageId("chat.edit.submitRejected");
        }
      } catch (error) {
        // 规则 37：命令未送达也是被拒（dispatchCommand 在连接未就绪时抛 ConnectionClosed）。
        // 文案单独区分连接类失败；不再让异常逃逸成 unhandled rejection（修复前即如此，纯静默）。
        setSubmitRejectedMessageId("chat.edit.submitRejectedConnection");
        logger.warn("[v4-edit] 提交未送达（连接未就绪或已中断）", { error });
      } finally {
        setSubmitting(false);
      }
    },
    [editAttachments, editContextCount, editPromptContexts, onEdit, row.entityId, row.rowId],
  );
  // 中间轮提交的唯一入口（specs/message-history-edit.md 规则 15、23-26）：
  // 所有编辑提交一律先弹确认窗（specs/message-history-edit.md 规则 40，2026-10-06
  // 交互收口）：↑ 是唯一提交入口，不再有末轮直发捷径，也没有独立的「与文件一起
  // 重置」按钮。提交先做 fileRewindPreview 三态分流：无文件→纯对话 Undo 弹窗
  // （末轮走末轮文案变体）；有可恢复文件→文件清单双动作弹窗；有冲突→冲突弹窗
  // 三选。preview 不可用或失败时降级为纯对话 Undo 弹窗（提交后 blocked 兜底保留）。
  const requestSubmitEdit = useCallback(
    (nextText: string) => {
      setPendingSubmit({ text: nextText });
      const previewTarget = row.entityId
        ? context.previewFileRewind?.({ rowId: row.rowId, entityId: row.entityId })
        : undefined;
      // preserve（普通发送）也要做 preview 分流：编辑点之后有文件变更时，
      // 用户必须在弹窗里看到文件后果并在「含文件恢复 / 不动文件」间显式选择
      // （specs/message-history-edit.md 规则 25）；只对 rewind 做 preview 会让
      // 文件清单弹窗永远打不开。无 preview 目标（无 entityId/接口缺失）才直接
      // 降级纯对话弹窗。
      if (!previewTarget) {
        setUndoConfirmOpen(true);
        return;
      }
      setFileRewindPreviewLoading(true);
      previewTarget
        .then((preview) => {
          const decision = resolveEditFileRewindDialogDecision(preview);
          if (decision.variant === "conversationOnly") {
            setUndoConfirmOpen(true);
            return;
          }
          setFileRewindPreview(preview);
          setPendingFileRewind({
            variant: decision.variant,
            allowOverwrite: decision.variant === "conflict" ? decision.allowOverwrite : false,
          });
          if (decision.variant === "conflict") {
            setConflictPreview(preview);
            setConflictOpen(true);
          } else {
            setUndoConfirmOpen(true);
          }
        })
        .catch(() => {
          // preview 失败不阻塞编辑：降级为纯对话 Undo 弹窗，文件冲突由提交后
          // blocked 兜底（handleSubmitEdit 的 conflict 分支）接管。
          setUndoConfirmOpen(true);
        })
        .finally(() => setFileRewindPreviewLoading(false));
    },
    [
      context,
      editTruncateTurns,
      row.entityId,
      row.rowId,
    ],
  );
  const executePendingSubmit = useCallback(
    (options?: {
      forceWorkspaceMode?: "preserve" | "rewind";
      fileRewindConflict?: "overwrite";
    }) => {
      if (!pendingSubmit) return;
      const { text } = pendingSubmit;
      // 双动作由弹窗按钮决定（规则 25）：withFiles 主按钮=rewind，
      // 「不动文件」=preserve；纯对话弹窗没有文件后果，恒 preserve。
      const workspaceMode = options?.forceWorkspaceMode ?? "preserve";
      setUndoConfirmOpen(false);
      setConflictOpen(false);
      setPendingFileRewind(null);
      setPendingSubmit(null);
      void handleSubmitEdit(text, workspaceMode, {
        mode: editMode,
        modelSelection: editModelSelection,
        ...(options?.fileRewindConflict ? { fileRewindConflict: options.fileRewindConflict } : {}),
      });
    },
    [editMode, editModelSelection, handleSubmitEdit, pendingSubmit],
  );
  // withFiles 弹窗的 destructive 主按钮是「含文件恢复」，必须强制 rewind，否则
  // 按钮文案与实际行为不符（点了恢复却保留文件）。纯对话弹窗保持 preserve。
  const confirmUndoSubmit = useCallback(() => {
    executePendingSubmit(
      pendingFileRewind?.variant === "withFiles"
        ? { forceWorkspaceMode: "rewind" }
        : undefined,
    );
  }, [executePendingSubmit, pendingFileRewind]);
  // 冲突弹窗的平级动作（specs/message-history-edit.md 规则 26）：用户已确认意图，
  // 直接执行，不再回退到 Undo 二次弹窗；blocked 兜底路径（pendingSubmit 为空）
  // 用当前草稿文本。
  const executeConflictSubmit = useCallback(
    (workspaceMode: "preserve" | "rewind", fileRewindConflict?: "overwrite") => {
      setConflictOpen(false);
      setPendingFileRewind(null);
      setPendingSubmit(null);
      void handleSubmitEdit(pendingSubmit?.text ?? draft, workspaceMode, {
        mode: editMode,
        modelSelection: editModelSelection,
        ...(fileRewindConflict ? { fileRewindConflict } : {}),
      });
    },
    [draft, editMode, editModelSelection, handleSubmitEdit, pendingSubmit],
  );

  if (editing) {
    return (
      <RowShell rowId={row.rowId} className="flex flex-col items-end">
        {submitRejectedMessageId ? (
          <p
            data-testid={testId(TID_V4_EDIT_SUBMIT_REJECTED, String(row.rowId))}
            className="mb-2 max-w-xl rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-ui-sm text-destructive"
          >
            {intl.formatMessage({ id: submitRejectedMessageId })}
          </p>
        ) : null}
        <ChatPromptEditor
          workspacePath={context.workspacePath}
          taskId={context.sessionId ?? null}
          // 规则 39：开卡时定格的 initialValue——停靠恢复的半编辑草稿或原文。
          initialValue={editInitialValue}
          submitting={submitting}
          submitDisabled={!canSubmit || submitting}
          allowSubmitWhenEmpty={editAttachments.length > 0 || editContextCount > 0}
          submitLabel={submitLabel}
          cancelLabel={cancelLabel}
          showMentionButton
          showSlashButton
          enableWorkspaceFileDrop
          restoreMentionNodes
          topContent={
            editAttachments.length > 0 || editContextCount > 0 ? (
              <div className="flex max-w-full flex-col items-start gap-2">
                {editAttachments.length > 0 ? (
                  <UserInputAttachmentList
                    attachments={editAttachments}
                    attachmentIndices={editAttachmentIndices}
                    entityId={row.entityId}
                    rowId={row.rowId}
                    onRemove={handleRemoveEditAttachment}
                    sessionId={context.sessionId ?? undefined}
                    readAttachment={context.readAttachment}
                    readAttachmentRange={context.readAttachmentRange}
                  />
                ) : null}
                {editContextCount > 0 ? (
                  <div
                    className="flex max-w-full flex-wrap items-center gap-2"
                    data-v4-user-edit-context-attachments-row="true"
                  >
                    <CodeCommentAttachmentChip
                      comments={editPromptContexts.codeComments}
                      onRemove={(comment) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: current.codeComments.filter((item) => item !== comment),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: [],
                        }))
                      }
                    />
                    <WebElementContextAttachmentChip
                      contexts={editPromptContexts.webElements}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: current.webElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: [],
                        }))
                      }
                    />
                    <PptxElementReferenceChip
                      references={editPromptContexts.pptxElements}
                      onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: current.pptxElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: [],
                        }))
                      }
                    />
                    <ConversationSelectionReferenceChip
                      references={editPromptContexts.conversationSelections}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: current.conversationSelections.filter(
                            (item) => !("id" in item) || item.id !== id,
                          ),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: [],
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null
          }
          inputApiRef={inputApiRef}
          inputTestId={testId(TID_V4_EDIT_INPUT, String(row.rowId))}
          submitTestId={testId(TID_V4_EDIT_SUBMIT, String(row.rowId))}
          cancelTestId={testId(TID_V4_EDIT_CANCEL, String(row.rowId))}
          // × 落在模型名与 rewind 之后、与发送键相邻；Esc 快捷键走编辑器独立 keydown，不受位置影响。
          cancelPosition="afterBetween"
          // trailing 弹性填满工具条剩余宽度：冻结标签向左伸展吃掉中部空白（见
          // conversationEditFrozenDisplay.ts）。正式大输入框不传，布局零变化。
          trailingFlexible
          leadingActions={
            <V4ComposerModeSwitch
              workspacePath={context.workspacePath}
              {...(context.workspaceIdentity
                ? { workspaceIdentity: context.workspaceIdentity }
                : {})}
              provider={ZCODE_AGENT_PROVIDER}
              draftConfig={editDraftConfig}
              disabled={false}
              activeConfigPicker={editConfigPicker}
              // 签名是 (picker, open)：直接传 setState 会把关闭事件写成
              // "model"/"thought"，菜单永远关不上并把 body 锁在 pointer-events:none。
              onConfigPickerOpenChange={(picker, open) => setEditConfigPicker(open ? picker : null)}
              onSwitchMode={(mode) => setEditMode(mode as UserInputRow["admissionMode"])}
            />
          }
          betweenCancelAndSubmitAction={
            <>
              <V4ComposerModelControls
                workspacePath={context.workspacePath}
                sessionId={context.sessionId ?? null}
                phase={null}
                {...(context.workspaceIdentity
                  ? { workspaceIdentity: context.workspaceIdentity }
                  : {})}
                modelSelectionView={context.modelSelectionView ?? null}
                modelSelectionState={editModelSelectionState}
                provider={ZCODE_AGENT_PROVIDER}
                draftConfig={editDraftConfig}
                usage={editControlsRuntime?.usage ?? null}
                disabled={false}
                activeConfigPicker={editConfigPicker}
                onConfigPickerOpenChange={(picker, open) => setEditConfigPicker(open ? picker : null)}
                onSelectModel={handleEditSelectModel}
                onSelectThought={handleEditSelectThought}
                onSwitchMode={(mode) => setEditMode(mode as UserInputRow["admissionMode"])}
                hideConfigAnchor
                // 编辑卡窄于主 composer：模型 trigger 恒为图标态，provider/model
                // 名称只留 tooltip 与菜单（用户决定，省工具条横向空间）。
                forceCompactModelTrigger
              />
            </>
          }
          className="w-full max-w-xl"
          shellClassName="min-h-32"
          onChange={setDraft}
          onSubmit={(nextText) => {
            requestSubmitEdit(nextText);
          }}
          onCancel={handleCancelEdit}
        />
        <EditTruncateConfirmDialog
          open={undoConfirmOpen}
          onOpenChange={(open) => {
            setUndoConfirmOpen(open);
            if (!open) setPendingFileRewind(null);
          }}
          truncateTurns={editTruncateTurns}
          submitting={submitting}
          preview={pendingFileRewind?.variant === "withFiles" ? fileRewindPreview : null}
          onConfirm={confirmUndoSubmit}
          onConfirmKeepFiles={() => executePendingSubmit({ forceWorkspaceMode: "preserve" })}
        />
        <ConversationFileRewindDialog
          variant="editConflict"
          open={conflictOpen}
          onOpenChange={(open) => {
            setConflictOpen(open);
            if (!open) setPendingFileRewind(null);
          }}
          preview={conflictPreview}
          previewLoading={fileRewindPreviewLoading}
          applying={submitting}
          error={null}
          onApply={() => {}}
          allowOverwrite={
            pendingFileRewind?.variant === "conflict" ? pendingFileRewind.allowOverwrite : false
          }
          onConversationOnly={() => executeConflictSubmit("preserve")}
          onOverwrite={
            pendingFileRewind?.allowOverwrite
              ? () => executeConflictSubmit("rewind", "overwrite")
              : undefined
          }
        />
      </RowShell>
    );
  }

  return (
    <RowShell rowId={row.rowId} className="group/user-row flex flex-col items-end">
      {hasAttachmentArea ? (
        <div
          data-v4-user-input-attachments="true"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(row.rowId))}
          className="mb-2 flex max-w-xl flex-col items-end gap-2"
        >
          {hasMediaAttachments ? (
            <div
              data-v4-user-input-media-attachments="true"
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              <UserInputAttachmentList
                attachments={row.attachments}
                entityId={row.entityId}
                attachmentKind="media"
                directItems
                rowId={row.rowId}
                sessionId={context.sessionId ?? undefined}
                readAttachment={context.readAttachment}
                readAttachmentRange={context.readAttachmentRange}
              />
            </div>
          ) : null}
          {hasAttachmentPills ? (
            <div
              data-v4-user-input-attachment-pills="true"
              // 非媒体文件与上下文引用必须共享这一层，才能在换行时
              // 保持“文件→评论→网页→PPT→对话引用”的顺序和统一右对齐。
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              {hasFileAttachments ? (
                <UserInputAttachmentList
                  attachments={row.attachments}
                  entityId={row.entityId}
                  attachmentKind="file"
                  directItems
                  rowId={row.rowId}
                  sessionId={context.sessionId ?? undefined}
                  readAttachment={context.readAttachment}
                  readAttachmentRange={context.readAttachmentRange}
                />
              ) : null}
              <CodeCommentAttachmentChip comments={codeCommentContexts} contentAlign="end" />
              <WebElementContextAttachmentChip contexts={webElementContexts} contentAlign="end" />
              <PptxElementReferenceChip
                references={pptxElementReferences}
                contentAlign="end"
                onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
              />
              <ConversationSelectionReferenceChip
                references={conversationSelections}
                contentAlign="end"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {hasBubble ? (
        // 附件和上下文引用只属于消息行，不属于气泡；否则仅附件消息会留下空气泡。
        // 同一 row 会渲染在主会话和 Subagent 侧栏，固定宽度会忽略实际宿主宽度。
        // 气泡保留 flex item 的自动宽度；宿主至少 624px 时再以 36rem 封顶并保留 48px 余量。
        <div
          data-v4-user-input-bubble="true"
          className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl"
        >
          {hasVisibleText ? (
            <ConversationUserInputBody contentText={visibleText} rowId={row.rowId}>
              <ConversationUserInputContent
                text={visibleText}
                attachments={row.attachments}
                contextAttachmentCount={countComposerPromptContexts(parsedPrompt)}
                whitelist={mentionWhitelist}
              />
            </ConversationUserInputBody>
          ) : null}
          {epilogue === undefined ? null : <ConversationUserInputEpilogue text={epilogue} />}
        </div>
      ) : null}
      {status ? (
        <div
          data-v4-user-input-status="true"
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          aria-live="polite"
        >
          {status}
        </div>
      ) : null}
      {/* 手机远控没有 hover 也没有 Tab 键，group-hover 与 focus-within 两条显形路径
          都不成立，复制和编辑入口会永久停在 opacity-0。触屏端由 [@media(hover:none)]
          变体常驻，桌面端继续通过 hover/focus 降噪，两条规则并存。
          不加 mt-*：这一行常态 opacity-0 仍占 24px（变体常驻后填的就是这 24px，
          不产生位移），再叠一段上边距就是纯浪费，贴住气泡底边即可。 */}
      <MessageActions className="opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <CopyRowAction
          text={row.text}
          rowId={row.rowId}
          label={intl.formatMessage({ id: "chat.message.copy" })}
        />
        {onEdit && row.entityId ? (
          <MessageAction
            label={intl.formatMessage({ id: "chat.message.edit" })}
            tooltip={intl.formatMessage({ id: "chat.message.edit" })}
            data-testid={testId(TID_V4_EDIT, String(row.rowId))}
            onClick={handleOpenEdit}
          >
            <PencilIcon className="size-3.5" />
          </MessageAction>
        ) : null}
      </MessageActions>
    </RowShell>
  );
});

export const ConversationAssistantTextActions = memo(function ConversationAssistantTextActions({
  rowId,
  entityId,
  text,
  createdAt,
  hookInvocations,
  turnId,
  onFork,
  className,
}: {
  rowId: number;
  entityId?: string;
  text: string;
  createdAt: number;
  feedback?: AssistantMessageFeedback | null;
  hookInvocations?: readonly HookInvocationRow[];
  sessionId?: string | null;
  turnId?: string;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  const forkLabel = intl.formatMessage({ id: "chat.message.fork" });
  const timeLabel = formatMessageTimeLabel(createdAt, locale, intl);
  const resolveTooltip = (label: string): string | undefined => label;

  const handleFork = useCallback(() => {
    if (entityId) {
      runUserAction({
        input: { featureId: "conversation.history.branch", action: "fork", trigger: "button" },
        operation: () => onFork?.({ rowId, entityId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "fork",
      });
    }
  }, [entityId, onFork, rowId]);
  return (
    <MessageActions className={cn(className)}>
      <CopyRowAction
        text={text}
        rowId={rowId}
        label={copyLabel}
        tooltip={resolveTooltip(copyLabel)}
      />
      {onFork && entityId ? (
        <MessageAction
          aria-label={forkLabel}
          label={forkLabel}
          tooltip={resolveTooltip(forkLabel)}
          data-testid={testId(TID_V4_FORK, String(rowId))}
          onClick={handleFork}
        >
          <TrendingUpDownIcon className="size-3.5" />
        </MessageAction>
      ) : null}
      {turnId && hookInvocations ? (
        <ConversationHookDetailsAction rows={hookInvocations} turnId={turnId} />
      ) : null}
      {/* 旧 conversation surface 删除后，V4 动作栏漏掉了消息创建时间；
          时间是 row.createdAt 的只读派生展示，不新增 renderer 状态。 */}
      {timeLabel ? (
        <span className="select-none text-ui-sm text-foreground-subtlest">{timeLabel}</span>
      ) : null}
    </MessageActions>
  );
});

const AssistantTextRowView = memo(function AssistantTextRowView({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  hideActions,
  deferActions,
  copyText,
  previewCards,
  previewCardsAutoOpenKey,
  codeCommentCards,
  codeCommentProjectionEnabled,
}: {
  row: AssistantTextRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  hideActions?: boolean;
  deferActions?: boolean;
  copyText?: string;
  previewCards?: AssistantPreviewCard[];
  previewCardsAutoOpenKey?: string;
  codeCommentCards?: AssistantCodeCommentCard[];
  codeCommentProjectionEnabled?: boolean;
}) {
  const streaming = row.state === "streaming";
  const isOfficeMode = useIsOfficeMode();
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const projectsCodeComments = codeCommentCardsEnabled && codeCommentProjectionEnabled === true;
  const visibleText = useMemo(
    () =>
      projectsCodeComments
        ? projectAssistantCodeComments(row.text, { streaming }).visibleText
        : row.text,
    [projectsCodeComments, row.text, streaming],
  );
  const visiblePreviewCards = previewCards && previewCards.length > 0 ? previewCards : null;
  return (
    <RowShell rowId={row.rowId} className="group/assistant-row">
      {/* assistant 文本走 streamdown（MessageResponse），
          markdown/代码块正式渲染；streaming 模式对未闭合 markdown 容错。 */}
      {/* MessageResponse 只消费自身声明的 props，不会把 data-* 透传到真实 DOM，
          导致 assistant 正文虽然在 JSX 上标了 selectable，框选逻辑却永远找不到该区域。
          selectable 语义必须放在稳定的 DOM 包装层上，完成态和 streaming 共用同一路径。 */}
      <div data-conversation-selectable="true" className="w-full text-ui-base">
        <MessageResponse
          renderZCodeFileCitations
          streaming={streaming}
          workspacePath={context.workspacePath}
          workspaceIdentity={context.workspaceIdentity}
          workspaceRemoteSessionId={context.workspaceRemoteSessionId}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          forceCodeWrap={isOfficeMode}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenExternalUrl={context.onOpenBrowserUrl}
          sessionId={context.sessionId ?? undefined}
          readAttachment={context.readAttachment}
        >
          {visibleText}
        </MessageResponse>
      </div>
      {codeCommentCardsEnabled && codeCommentCards && codeCommentCards.length > 0 ? (
        <div className="mt-3">
          <AssistantCodeCommentCards
            cards={codeCommentCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenCodeViewer={context.onOpenCodeViewer}
          />
        </div>
      ) : null}
      {visiblePreviewCards ? (
        <div className="mt-3">
          <AssistantPreviewCards
            cards={visiblePreviewCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            autoOpenPptxKey={previewCardsAutoOpenKey}
            onAutoOpenPptx={context.onAutoOpenAssistantPptx}
          />
        </div>
      ) : null}
      {/* 完成态动作行悬停显现（对齐旧 MessageActions）：复制 + fork（图标 ghost）。
          一轮对用户是一个回复：action 只在轮尾段（hideActions 由 TurnGroup 裁决），
          复制内容 = 整轮全部 text 段合并（copyText 覆盖）。
          [@media(hover:none)] 与轮级 turnTailActionsClassName 同源：触屏端常驻，
          否则本路径与轮组路径的显隐行为会漂。 */}
      {row.state === "complete" && !hideActions && !deferActions ? (
        <ConversationAssistantTextActions
          rowId={row.rowId}
          entityId={row.entityId}
          text={copyText ?? row.text}
          createdAt={row.createdAt}
          feedback={readAssistantFeedback(row)}
          sessionId={context.sessionId}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          className="opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
        />
      ) : null}
    </RowShell>
  );
});

const ReasoningRowView = memo(function ReasoningRowView({
  row,
  contentVariant,
}: {
  row: ReasoningRow;
  contentVariant?: "default" | "nested";
}) {
  const streaming = row.state === "streaming";
  // 外观对齐旧 ThoughtBlock（旧版 chatMessageParts）：ai-elements Reasoning
  // 折叠组件。交互调整原因：流式 reasoning 默认展开会持续挤压工具和正文空间；
  // 现在 streaming/complete 都默认收起，只保留运行态文案，用户可手动展开。
  // autoCollapseKey 仍保证状态边界不会覆盖已经发生过的用户交互。
  // 纯签名 reasoning（Responses 加密思考无摘要、空 delta）没有可读文本，
  // 不渲染行：避免“思考 N 次”计数虚增，以及零文本行闭合时 durationMs=0 显示“耗时 1 秒”。
  if (row.text.length === 0) {
    return null;
  }
  return (
    <RowShell rowId={row.rowId}>
      <Reasoning
        className="w-full"
        isStreaming={streaming}
        autoCollapseKey={streaming ? null : row.state}
        // 思考中的秒数以行的 createdAt 为起点现算，与闭合时投影写入的 durationMs 同量；
        // 起点来自行数据，组件重建（切会话、列表回收）不会让数字归零。
        startedAt={row.createdAt}
        // 直接传毫秒：毫秒 → 秒的换算只在 Reasoning 内部的 reasoningDurationSeconds 做一次。
        durationMs={row.durationMs}
      >
        {/* 附件重构合并时误丢了 streamingText 接线，导致摘要组件仍在但永远收到空文本。 */}
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent variant={contentVariant}>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </RowShell>
  );
});

const TurnHeaderRowView = memo(function TurnHeaderRowView({ row }: { row: TurnHeaderRow }) {
  return (
    <RowShell
      rowId={row.rowId}
      className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
    >
      turn · {row.origin} · {row.state}
    </RowShell>
  );
});

/** 分隔线图标（对齐旧版 synthetic-timeline dividers：size-3.5 subtle）。 */
const MARKER_ARCHIVE_ICON = (
  <ArchiveIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_FORK_ICON = (
  <GitBranchIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_GOAL_ICON = (
  <GoalIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_MODEL_ICON = (
  <ArrowRightLeftIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);

/**
 * 系统标记分隔线壳：两侧细横线 + 居中「图标 + 文案」pill，视觉对齐旧版
 * ChatMessage synthetic-timeline dividers（fork / compaction / goal 同款）。
 * running（压缩/校验进行中）隐藏图标、文案走 animated-gradient-text 流光（同旧版）。
 */
function MarkerDividerRow({
  rowId,
  markerType,
  markerStatus,
  markerOrigin,
  markerSourceCommandId,
  icon,
  label,
  running = false,
  onClick,
}: {
  rowId: number;
  markerType: TimelineMarkerRow["marker"]["type"];
  markerStatus: string;
  markerOrigin?: string;
  markerSourceCommandId?: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  running?: boolean;
  /** 传入即整行可点（fork→跳父会话）；不传为静态分隔线。 */
  onClick?: () => void;
}) {
  const clickable = Boolean(onClick);
  const rowClassName =
    "flex w-full items-center gap-3 px-4 py-2 text-ui-base text-[var(--color-foreground-subtle)]";
  const inner = (
    <>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
      <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5 text-center leading-5">
        {running ? null : icon}
        <span
          className={`min-w-0 break-words${running ? " animated-gradient-text font-medium" : ""}${clickable ? " underline-offset-4 group-hover/marker:underline" : ""}`}
        >
          {label}
        </span>
      </span>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
    </>
  );
  if (onClick) {
    // 整行 <button>（对齐旧版 fork divider）：hover 变亮 + 文案下划线示意可点。
    return (
      <button
        type="button"
        data-row-id={rowId}
        data-row-kind="timelineMarker"
        data-marker-type={markerType}
        data-status={markerStatus}
        data-origin={markerOrigin}
        data-source-command-id={markerSourceCommandId}
        data-testid={testId(TID_V4_ROW, String(rowId))}
        onClick={onClick}
        className={`group/marker ${rowClassName} text-left transition-colors hover:text-[var(--color-foreground)]`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      data-row-id={rowId}
      data-row-kind="timelineMarker"
      data-marker-type={markerType}
      data-status={markerStatus}
      data-origin={markerOrigin}
      data-source-command-id={markerSourceCommandId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={rowClassName}
    >
      {inner}
    </div>
  );
}

/**
 * timelineMarker 行渲染：compact / forkNotice / goalVerify / modelChange 画成分隔线。
 * modelChange 可见化 = 裁决（切换后实际发送出去的轮才落分隔，含
 * model-only 续跑轮）；goalSet/forkCreated 已在投影层停产（隐形行清零），
 * retryNotice·checkpointRestored 无 UI，default 分支兜底不渲染。
 */
const TimelineMarkerRowView = memo(function TimelineMarkerRowView({
  row,
  context,
}: {
  row: TimelineMarkerRow;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const marker = row.marker;
  const modelSelectionView = context.modelSelectionView ?? null;
  const view = useMemo((): {
    icon: React.ReactNode;
    label: React.ReactNode;
    running: boolean;
  } | null => {
    switch (marker.type) {
      case "compact": {
        const running = marker.status === "running";
        const automaticOptimization = isOfficeMode && marker.origin === "auto";
        const scope = automaticOptimization ? "chat.contextOptimization" : "chat.contextCompaction";
        const statusMessage =
          marker.status === "running"
            ? "started"
            : marker.status === "noop"
              ? "skipped"
              : marker.status === "cancelled"
                ? "interrupted"
                : marker.status === "failed"
                  ? "failed"
                  : marker.origin === "auto" && !automaticOptimization
                    ? "completedAuto"
                    : "completed";
        return {
          icon: MARKER_ARCHIVE_ICON,
          label: intl.formatMessage({ id: `${scope}.${statusMessage}` }),
          running,
        };
      }
      case "forkNotice":
        return {
          icon: MARKER_FORK_ICON,
          label: intl.formatMessage({ id: "chat.message.fork.derivedFrom" }),
          running: false,
        };
      case "modelChange": {
        // marker 已携带完整 provider/model 元组，旧渲染却只读取 model，
        // 且没有订阅 provider snapshot，导致同名模型无差异、目录水合后名称不刷新。
        // 这里保留 provider ID fallback，并让现有 marker 随目录更新。
        const fromProvider = resolveProviderLabel(marker.fromProvider, modelSelectionView);
        const toProvider = resolveProviderLabel(marker.toProvider, modelSelectionView);
        // 分隔线上说「用的是什么模型」时，把思考档位接在模型名后面：marker 的 payload 本来
        // 就带着 toThought，缺的是渲染。档位只有落到 to 这一段上，from 段不带——
        // 切换记录关心的是「现在跑在什么档位上」。
        const to = formatModelChangeThoughtLabel({
          modelLabel: formatModelChangeLabel(marker.toProvider, toProvider, marker.toModel, intl),
          thought: marker.toThought,
          intl,
        });
        if (marker.fromProvider === undefined || marker.fromModel === undefined) {
          return {
            // source-less 表示首次使用的模型事实，不是模型切换，因此不显示切换箭头。
            icon: null,
            label: intl.formatMessage({ id: "chat.modelChange.using" }, { model: to }),
            running: false,
          };
        }
        return {
          icon: MARKER_MODEL_ICON,
          label: intl.formatMessage(
            { id: "chat.modelChange.switched" },
            {
              from: formatModelChangeLabel(
                marker.fromProvider,
                fromProvider,
                marker.fromModel,
                intl,
              ),
              to,
            },
          ),
          running: false,
        };
      }
      case "goalVerify": {
        const running = marker.outcome === "running";
        // pass→完成；notSatisfied/failed→未完成（沿用旧版 failed_closed 归「未完成」的处理）。
        const statusId =
          marker.outcome === "running"
            ? "chat.goalVerification.checking"
            : marker.outcome === "pass"
              ? "chat.goalVerification.complete"
              : "chat.goalVerification.incomplete";
        return {
          icon: MARKER_GOAL_ICON,
          running,
          // innerText 形如「第 1 次迭代 · 目标校验中」，对齐 goal-timeline 待命 e2e 断言。
          label: (
            <>
              <span>
                {intl.formatMessage(
                  { id: "chat.summaryPanel.goalIterationValue" },
                  { count: String(marker.iteration) },
                )}
              </span>
              <span aria-hidden="true"> · </span>
              {intl.formatMessage({ id: statusId })}
            </>
          ),
        };
      }
      default:
        return null;
    }
  }, [intl, isOfficeMode, marker, modelSelectionView]);

  // fork 跳父会话（Tier 1）：仅 forkNotice 且宿主提供 onNavigateToRow 时可点，
  // 切到 marker.parentSessionId（rowId 预留 Tier 2 精确滚动，当前恒 0 占位）。
  const onNavigate = context.onNavigateToRow;
  const handleClick = useMemo(() => {
    if (marker.type !== "forkNotice" || !onNavigate) {
      return undefined;
    }
    return () => onNavigate(marker.parentSessionId, marker.parentRowId);
  }, [marker, onNavigate]);

  if (!view) {
    return null;
  }
  return (
    <MarkerDividerRow
      rowId={row.rowId}
      markerType={marker.type}
      markerStatus={
        marker.type === "compact"
          ? marker.status
          : marker.type === "goalVerify"
            ? marker.outcome
            : marker.type === "forkNotice"
              ? "created"
              : "applied"
      }
      markerOrigin={marker.type === "compact" ? marker.origin : undefined}
      markerSourceCommandId={row.sourceCommandId}
      icon={view.icon}
      label={view.label}
      running={view.running}
      onClick={handleClick}
    />
  );
});

const ToolCallRowView = memo(function ToolCallRowView({
  row,
  context,
}: {
  row: ToolCallRow;
  context: ConversationRowRenderContext;
}) {
  // toolCall 行回接 ToolCallBlocks（execute/read/edit/... renderer 按
  // tool identity 分流）。适配 memo 按 row 引用：row.delta/upserted 换新对象才重建。
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  // workflow run 详情入口的门控：run 身份走 workflowRuns 投影（schema 里 toolCallId 就是
  // 「工具卡 → 详情页的关联键」），不从工具输出里读——v4 行的 output 只剩一句散文。
  // 命中的摘要同时决定卡片形态：有 run 就是紧凑可点卡，没有就是可展开卡。
  const workflowRun =
    context.workflowRunByToolCallId?.get(row.toolCallId) ??
    // ResumeWorkflowRun 行按 runId 联接：display 载荷带 runId（≡ backgroundTaskId），而投影
    // 的 run.toolCallId 跨 resume 沿用原始 CreateWorkflow 行——resume 行按 toolCallId 永远
    // 查不到。命中后 onOpenWorkflowRun 的收窄走同一条路径，tab 身份 runId 键、幂等。
    (row.display?.kind === "resume_workflow_run"
      ? context.workflowRunByRunId?.get(row.display.runId)
      : undefined);
  // 原因：已启动的工具卡与轮尾摘要重复画同一条实时进度；上方改为普通摘要入口。
  // 只替换成功关联的发起行，编译诊断及 Resume 等其他工具仍走原有渲染。
  if (
    workflowRun &&
    context.workflowRunByToolCallId?.has(row.toolCallId) &&
    row.status !== "error"
  ) {
    const workflowName = readWorkflowName(row.input);
    const sessionId = context.sessionId;
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={workflowRun}
          amend={isAmendWorkflowToolCall(row)}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                    ...(workflowName === undefined ? {} : { workflowName }),
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // 工具行去掉纵向内边距（对齐旧版无 per-tool padding）；连续工具间距由
  // ConversationAssistantWorkItems 的 gap-4 组容器统一给。
  return (
    <RowShell rowId={row.rowId} className="py-0">
      <div data-conversation-selectable="true">
        <ToolCallBlock
          toolCallNode={toolCallNode}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          showTodoToolCalls={context.messageStreamShowTodos === true}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          agentTitleByIdentity={context.agentTitleByIdentity}
          workTitleByIdentity={context.workTitleByIdentity}
          onOpenPlanDetail={
            context.onOpenPlanDetail && context.sessionId
              ? (request) =>
                  context.onOpenPlanDetail?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                  })
              : undefined
          }
          onOpenPlanDirectory={context.onOpenPlanDirectory}
          onOpenBackgroundBash={
            context.onOpenBackgroundBash && context.sessionId
              ? (request) =>
                  context.onOpenBackgroundBash?.({
                    ...request,
                    sessionId: context.sessionId!,
                    rootSessionId: context.rootSessionId ?? context.sessionId!,
                    workspacePath: context.workspacePath,
                    ...(context.workspaceIdentity
                      ? { workspaceIdentity: context.workspaceIdentity }
                      : {}),
                    ...(context.workspaceRemoteSessionId
                      ? { remoteSessionId: context.workspaceRemoteSessionId }
                      : {}),
                  })
              : undefined
          }
          onExecutePlan={context.onExecutePlan}
          onOpenWorkflowRun={
            context.onOpenWorkflowRun && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowRun?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    // 打开请求的关联键是发起行（CreateWorkflow）id，不是点中行的 id——
                    // resume 行点开时两者不同，详情页拿它找 causalityGraph/脚本。
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onOpenWorkflowActor={
            context.onOpenWorkflowActor && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowActor?.({ ...request, parentSessionId: context.sessionId! })
              : undefined
          }
          // 脚本药丸 → 脚本 transcript：关联键同 onOpenWorkflowRun（发起行 id + runId）。
          onOpenWorkflowWorkspace={
            context.onOpenWorkflowWorkspace && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowWorkspace?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onResumeWorkflowRun={
            context.onResumeWorkflowRun && workflowRun?.resumable
              ? (request) => context.onResumeWorkflowRun?.(workflowRun.runId, request.workflowName)
              : undefined
          }
          // 产物药丸 → 产物 tab：与通知行的 chips 同一条打开路径（不带版本号，打开即最新版）。
          onOpenWorkflowArtifact={
            context.onOpenWorkflowArtifact && context.sessionId && workflowRun
              ? (artifactId) => {
                  // 活投影的产物摘要带最新版的 `contentType`（宿主据它把 html 产物直接开成
                  // 浏览器 tab）；`sourcePath` 那份摘要刻意不带，缺席时宿主自己查 journal。
                  const artifact = workflowRun.run?.artifacts?.find(
                    (candidate) => candidate.id === artifactId,
                  );
                  context.onOpenWorkflowArtifact?.({
                    parentSessionId: context.sessionId!,
                    runId: workflowRun.runId,
                    artifactId,
                    ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                    ...(artifact?.contentType === undefined
                      ? {}
                      : { contentType: artifact.contentType }),
                  });
                }
              : undefined
          }
          workflowRun={workflowRun}
          workflowDraft={context.workflowDraftByToolCallId?.get(row.toolCallId)}
        />
      </div>
    </RowShell>
  );
});

const SubagentRowView = memo(function SubagentRowView({ row }: { row: SubagentRow }) {
  // subagent 行已经和 Agent/Task 工具行配对渲染；裸行只保留异常兜底摘要，
  // 避免再生成一个“子会话”卡片或第二套下钻入口。
  const summary = (
    <>
      {row.subagentType} · {row.status}
      {row.summaryText ? ` — ${row.summaryText}` : ""}
    </>
  );
  return (
    <RowShell rowId={row.rowId}>
      <div className="text-ui-sm text-[var(--color-foreground-subtle)]">{summary}</div>
    </RowShell>
  );
});

/**
 * v4 row 渲染分发。memo：虚拟列表逐行渲染，父投影变化时只有 props 真正变化的行才重渲染
 * （前提是 onFork/onRetry/onEdit 为稳定引用 + context 引用稳定，见 SessionPane 的
 * useCallback/useMemo）。
 */
function ConversationRowViewImpl({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationRowViewProps) {
  // 行级弱化预览（规则 13）：编辑卡打开时，rowId 在其后的所有行（含编辑轮自身的回复行）
  // 统一降透明并禁交互，作为「将删除 N 轮」的可视化。收口在分发层这一处，替代此前
  // Timeline 的轮级弱化（轮级盖不住编辑轮内部行，两层叠加还会把后续轮压到 0.16）。
  const editDimmed =
    typeof context.editingRowId === "number" && row.rowId > context.editingRowId;
  return (
    <div
      data-edit-dimmed={editDimmed || undefined}
      className={cn(
        editDimmed &&
          "pointer-events-none select-none opacity-40 transition-opacity duration-150",
      )}
    >
      <RowViewSwitch
        row={row}
        context={context}
        onFork={onFork}
        onRetry={onRetry}
        onFeedbackChange={onFeedbackChange}
        onEdit={onEdit}
        hideAssistantActions={hideAssistantActions}
        deferAssistantActions={deferAssistantActions}
        assistantCopyText={assistantCopyText}
        assistantPreviewCards={assistantPreviewCards}
        assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
        assistantCodeCommentCards={assistantCodeCommentCards}
        assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        reasoningContentVariant={reasoningContentVariant}
        userInputStatus={userInputStatus}
      />
    </div>
  );
}

function RowViewSwitch({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationRowViewProps) {
  switch (row.kind) {
    case "userInput":
      return (
        <UserInputRowView
          row={row}
          context={context}
          onEdit={onEdit}
          status={userInputStatus}
        />
      );
    case "assistantText":
      return (
        <AssistantTextRowView
          row={row}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          hideActions={hideAssistantActions}
          deferActions={deferAssistantActions}
          copyText={assistantCopyText}
          previewCards={assistantPreviewCards}
          previewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          codeCommentCards={assistantCodeCommentCards}
          codeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      );
    case "reasoning":
      // 关闭“显示思考过程”只隐藏每轮后续 reasoning；首条 reasoning
      // 是该轮最小必要思考提示，必须由 turn 全序派生的 rowId 保留下来。
      return isConversationReasoningRowVisible(row.rowId, context) ? (
        <ReasoningRowView row={row} contentVariant={reasoningContentVariant} />
      ) : null;
    case "turnHeader":
      return <TurnHeaderRowView row={row} />;
    case "timelineMarker":
      return <TimelineMarkerRowView row={row} context={context} />;
    case "toolCall":
      // 只在 ToolCallBlock 内返回 null 会留下空 RowShell 和多余间距；
      // 在行分发处按同一工具身份规则裁剪，设置关闭时不产生任何 Todo DOM。
      if (
        context.messageStreamShowTodos !== true &&
        resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "todo"
      ) {
        return null;
      }
      return <ToolCallRowView row={row} context={context} />;
    case "subagent":
      return <SubagentRowView row={row} />;
    case "artifact":
      return <ArtifactRowView row={row} />;
    default:
      return null;
  }
}

export const ConversationRowView = memo(ConversationRowViewImpl);
