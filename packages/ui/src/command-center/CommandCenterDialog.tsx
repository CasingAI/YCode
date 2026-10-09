/* eslint-disable max-lines -- 聚合命令、任务、文件三类搜索结果，后续可按 result section 拆分。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { Command as CommandPrimitive } from "cmdk";
import {
  ChevronDownIcon,
  FileIcon,
  History as HistoryIcon,
  ListIcon,
  Loader2Icon,
  MessageSquareIcon,
  MessagesSquareIcon,
  RocketIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import type { WorkspaceFileEntry, ZCodeTaskChangeSummary, ZCodeTaskMeta } from "@zcode/shared";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import {
  buildTaskResultRows,
  type TaskSearchResultRow,
} from "@/command-center/commandCenterTaskRows.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import { QUICK_PICK_SECTION_ORDER, type QuickPickCommand } from "@/quickpick/quickPickCommands.js";
import { QUICK_PICK_ICON_BY_KIND } from "@/quickpick/quickPickCommandIcons.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickItemClassName,
  quickPickListClassName,
  quickPickMetadataClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";
import {
  clearCommandCenterSearchHistory,
  pushCommandCenterSearchHistory,
  readCommandCenterIncludeArchived,
  readCommandCenterSearchHistory,
  writeCommandCenterIncludeArchived,
  type CommandCenterSearchHistoryEntry,
  type CommandCenterSearchScope,
} from "@/command-center/commandCenterSearchHistory.js";
import { useAiHistorySearchRunner } from "@/command-center/useAiHistorySearch.js";
import {
  citationJumpText,
  selectAiSearchAnswerContent,
  type AiSearchActiveTool,
  type AiSearchCitation,
} from "@/command-center/aiSearchAnswerContent.js";
import {
  formatQueryPreview,
  historyListSummaryText,
  historyReadSummaryText,
  historySearchSummaryText,
  readSearchQueryFromInput,
} from "@/ToolCallBlocks/renderers/history.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";

const EMPTY_QUICK_PICK_COMMANDS: QuickPickCommand[] = [];
const EMPTY_COMMAND_CENTER_WORKSPACE_TABS: WorkspaceTabState[] = [];
const COMMAND_CENTER_SECTION_LIMIT = 3;
const COMMAND_CENTER_CONTEXT_SECTION_LIMIT = 3;
const COMMAND_CENTER_FILE_RESULT_LIMIT = 80;
const COMMAND_CENTER_TASK_RESULT_LIMIT = 80;
const commandCenterDialogClassName = cn(
  quickPickDialogClassName,
  // Linux 桌面端的通用 DialogContent 会给居中弹窗补偿自绘标题栏高度。
  // Command Center 是顶部搜索浮层，必须在 Linux variant 下重新声明 top，
  // 否则平台补偿会覆盖 top-16/sm:top-20，导致弹层掉到窗口中部。
  "top-16 max-h-[calc(100dvh-4.5rem)] -translate-y-0 sm:top-20 sm:max-h-[calc(100dvh-6rem)]",
  "platform-linux-desktop:top-16 sm:platform-linux-desktop:top-20",
);
const commandCenterListClassName = cn(
  quickPickListClassName,
  "max-h-[min(440px,calc(100dvh-15rem))]",
);

type CommandCenterSectionId = "commands" | "conversations" | "files";
type TaskChangedFileSummary = ZCodeTaskChangeSummary["files"][number];

function getWorkspaceFileDirectory(entry: WorkspaceFileEntry): string {
  const slashIndex = entry.relativePath.lastIndexOf("/");
  return slashIndex === -1 ? "" : entry.relativePath.slice(0, slashIndex);
}

function buildWorkspaceFileSearchText(entry: WorkspaceFileEntry): string {
  return `${entry.name} ${entry.relativePath}`.toLocaleLowerCase();
}

function filterWorkspaceFileEntries(
  entries: readonly WorkspaceFileEntry[],
  query: string,
): WorkspaceFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const parts = normalizedQuery.split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => entry.type === "file")
    .filter((entry) => {
      const searchText = buildWorkspaceFileSearchText(entry);
      return parts.every((part) => searchText.includes(part));
    })
    .slice(0, COMMAND_CENTER_FILE_RESULT_LIMIT);
}

function getTaskTitle(task: ZCodeTaskMeta, untitledLabel: string): string {
  return task.title.trim() || untitledLabel;
}

function compareRecentChangedFiles(left: TaskChangedFileSummary, right: TaskChangedFileSummary) {
  if (right.lastTurnIndex !== left.lastTurnIndex) {
    return right.lastTurnIndex - left.lastTurnIndex;
  }
  if (right.writeCount !== left.writeCount) {
    return right.writeCount - left.writeCount;
  }
  return left.path.localeCompare(right.path);
}

function resolveQueryScope(rawQuery: string): {
  query: string;
  scope: CommandCenterSearchScope;
  explicitScope: boolean;
} {
  const trimmed = rawQuery.trimStart();
  const prefix = trimmed[0];
  if (prefix === ">") {
    return { query: trimmed.slice(1).trimStart(), scope: "commands", explicitScope: true };
  }
  if (prefix === "#") {
    return { query: trimmed.slice(1).trimStart(), scope: "conversations", explicitScope: true };
  }
  if (prefix === "@") {
    return { query: trimmed.slice(1).trimStart(), scope: "files", explicitScope: true };
  }

  return { query: rawQuery.trim(), scope: "all", explicitScope: false };
}

function matchesCommand(command: QuickPickCommand, title: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const searchText = `${title} ${command.keywords.join(" ")}`.toLocaleLowerCase();
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => searchText.includes(part));
}

// scope tab 与「仅标题」开关共用的 chip 视觉：可交互范围切换控件，按 DESIGN.md
// 语义角色属于 common buttons，应使用 text-ui-base；不能用 text-ui-xs（10px，
// badge/counter 专用）。同时与上方搜索输入框 (text-ui-base) 保持一致。
function commandCenterScopeChipClassName(active: boolean): string {
  return cn(
    "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-ui-base font-medium leading-none transition-colors",
    active
      ? "border-border bg-selected text-foreground"
      : "border-transparent text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
  );
}

function CommandCenterScopeButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={commandCenterScopeChipClassName(active)}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

/**
 * 搜索历史 chip 的 scope 前缀（如 commands → ">"）。
 * 提取为独立函数以便 CommandCenterSearchHistory 组件复用。
 */
function scopeToPrefix(scope: CommandCenterSearchScope): string {
  switch (scope) {
    case "commands":
      return ">";
    case "conversations":
      return "#";
    case "files":
      return "@";
    default:
      return "";
  }
}

/**
 * 对话搜索结果的时间戳。
 * 独立组件便于复用与单测；按 DESIGN.md 语义角色，列表项里的相对时间属于
 * secondary copy，使用 text-ui-sm（不用 text-ui-xs，避免偏小）。
 */
function CommandCenterConversationTimestamp({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "max-w-12 shrink-0 truncate font-sans text-ui-sm tracking-normal text-foreground-subtlest",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * 命令中心搜索历史区：分区标题 + 历史 chip + 清除/展开按钮。
 * 从 CommandCenterDialog 内联 JSX 抽取，便于复用与单测。
 *
 * 字号语义（DESIGN.md）：
 * - 分区标题：text-ui-sm（section label / helper text）
 * - 历史 chip 搜索词：text-ui-base（可读内容，与列表主体一致）
 * - chip 内 scope 前缀：text-ui-xs（badge 标记，比主体小一级形成层级）
 */
function CommandCenterSearchHistory({
  entries,
  expanded,
  onToggleExpanded,
  onPickEntry,
  onClear,
  historyLabel,
  clearLabel,
  expandLabel,
  collapseLabel,
}: {
  entries: CommandCenterSearchHistoryEntry[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onPickEntry: (entry: CommandCenterSearchHistoryEntry) => void;
  onClear: () => void;
  historyLabel: string;
  clearLabel: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  const canExpand = entries.length > 6;
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2 text-ui-sm font-medium text-foreground-subtle">
        <span>{historyLabel}</span>
        <button
          type="button"
          aria-label={clearLabel}
          className="ml-auto inline-grid size-6 place-items-center rounded-md text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
          onClick={onClear}
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
      <div
        className={cn(
          "relative flex flex-wrap gap-1.5 overflow-hidden px-3 pt-1 pb-2 pr-11",
          expanded ? "" : "max-h-[34px]",
        )}
      >
        {entries.map((entry) => {
          const prefix = scopeToPrefix(entry.scope);
          return (
            <button
              key={`${entry.scope}:${entry.query}:${entry.updatedAt}`}
              type="button"
              // text-ui-base 随 --ui-font-size（12–20px）缩放，不能用固定 h-5
              // 否则 20px 字号下内容区（20px - 2px 边框 = 18px）装不下字体行盒，
              // 配合外层 overflow-hidden 会裁切文字。改用 min-h-5 + py-0.5 + leading-none
              // 让高度随字号增长，保证 12–20px 全范围可读。
              className="inline-flex min-h-5 max-w-44 shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 leading-none text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              onClick={() => onPickEntry(entry)}
            >
              {prefix ? <span className="font-mono text-ui-xs text-brand">{prefix}</span> : null}
              <span className="min-w-0 truncate">{entry.query}</span>
            </button>
          );
        })}
        {canExpand ? (
          <button
            type="button"
            aria-label={expanded ? collapseLabel : expandLabel}
            className="absolute top-1 right-3 inline-grid size-6 place-items-center rounded-md text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={onToggleExpanded}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", expanded ? "rotate-180" : "")}
            />
          </button>
        ) : null}
      </div>
    </>
  );
}

/**
 * 顶部第二行的工具摘要：与正常聊天工具行同一套折叠行文案实现
 * （History 三工具的 kind 文案 + 摘要 helpers），只读不展开。
 * display 缺席（运行中）时退回输入侧纯关键词；三工具之外回退工具名。
 */
function describeAiSearchTool(
  tool: AiSearchActiveTool,
  format: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): { kind: string; summary: string | null; running: boolean } {
  const display = readToolResultDisplay({ output: { display: tool.display } });
  const running = tool.running;
  if (tool.toolName === "HistorySearch") {
    const searchDisplay = display?.kind === "history_search" ? display : undefined;
    const summary =
      historySearchSummaryText(searchDisplay, format) ??
      (readSearchQueryFromInput(tool.input) === undefined
        ? null
        : formatQueryPreview(readSearchQueryFromInput(tool.input) as string));
    return {
      kind: format({
        id: running
          ? "chat.toolCall.history.search.searching"
          : "chat.toolCall.history.search.searched",
      }),
      summary,
      running,
    };
  }
  if (tool.toolName === "HistoryList") {
    const listDisplay = display?.kind === "history_list" ? display : undefined;
    return {
      kind: format({
        id: running ? "chat.toolCall.history.list.listing" : "chat.toolCall.history.list.listed",
      }),
      summary: historyListSummaryText(listDisplay, format) ?? null,
      running,
    };
  }
  if (tool.toolName === "HistoryRead") {
    const readDisplay = display?.kind === "history_read" ? display : undefined;
    return {
      kind: format({
        id: running ? "chat.toolCall.history.read.reading" : "chat.toolCall.history.read.read",
      }),
      summary: historyReadSummaryText(readDisplay, format) ?? null,
      running,
    };
  }
  return { kind: tool.toolName, summary: null, running };
}

/**
 * AI 来源行：与普通关键词任务行同一套 CommandItem 样式
 * （图标 + 标题/片段两行 + 相对时间），点后关浮层跳转高亮。
 */
function AiSearchCitationRow({
  citation,
  query,
  workspaceLabel,
  onJumpToCitation,
}: {
  citation: AiSearchCitation;
  query: string;
  workspaceLabel: string;
  onJumpToCitation: (citation: AiSearchCitation) => void;
}) {
  const { intl } = useZCodeIntl();
  const title = citation.title?.trim() || intl.formatMessage({ id: "taskList.untitled" });
  const snippet = citation.snippet.trim();
  return (
    <CommandItem
      key={`${citation.sessionId}:${citation.segment}`}
      value={`${title} ${citation.sessionId} ${snippet}`}
      className={quickPickItemClassName}
      onSelect={() => onJumpToCitation(citation)}
    >
      <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
      <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
        <span className="truncate text-ui-base leading-5 font-normal text-foreground">
          <HighlightedMatchText text={title} query={query} />
        </span>
        {snippet ? (
          <span className="min-w-0 truncate text-ui-base leading-4 text-foreground-subtle">
            <HighlightedMatchText text={snippet} query={query} />
          </span>
        ) : null}
      </span>
      <CommandShortcut className={quickPickMetadataClassName}>
        {workspaceLabel}
      </CommandShortcut>
      {citation.at !== null ? (
        <CommandCenterConversationTimestamp>
          {formatTaskRelativeTime(citation.at, intl)}
        </CommandCenterConversationTimestamp>
      ) : null}
    </CommandItem>
  );
}

/**
 * AI 搜索回答区（spec: docs/specs/command-center-ai-history-search.md）。
 * 浮层外壳和宽度不变，高度受现有上限约束，内容内部滚动。范围标签在回答态收起。
 * 从上到下：
 * 1. 顶部过程区（两行，常驻）：第一行是最新一条正文单行预览（运行前为占位，
 *    有正文后显示最新正文，失败换可操作错误），只占一行、超出省略；左侧图标
 *    运行中是 spinner，完成后换星星。第二行是最后一次工具调用，复用正常聊天
 *    工具行的折叠行文案实现（kind 文案 + 摘要 helpers）。
 * 2. 归纳正文：仅回合完成后出现，默认收起的一行入口，点击手动展开看最后一条
 *    完成消息（最终答案），用 MessageResponse 走 Markdown 渲染。
 * 3. 来源列表：仅回合完成后出现，与普通关键词任务行同一套列表样式（标题 +
 *    摘录 + 相对时间），点后关浮层跳转高亮。
 * 不展示完整工具卡、权限条、Composer、模型切换。运行中可 Esc 取消。
 */
function CommandCenterAiAnswer({
  query,
  status,
  error,
  lease,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceLabel,
  onRetry,
  onCancel,
  onJumpToCitation,
  onOpenCodeViewer,
}: {
  query: string;
  status: "idle" | "running" | "failed";
  error: string | null;
  lease: SessionLease | null;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceLabel: string;
  onRetry: () => void;
  onCancel: () => void;
  onJumpToCitation: (citation: AiSearchCitation) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage;
  const platform = useOptionalPlatform();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const projection = useConversationProjection(lease);
  const live = useMemo(() => selectAiSearchAnswerContent(projection), [projection]);
  // 会话回收后投影可能清空：保留最后一次非空内容，避免答案闪没；
  // 新一轮（lease 变化）则重新开始。
  const leaseRef = useRef(lease);
  const frozenRef = useRef(live);
  if (leaseRef.current !== lease) {
    leaseRef.current = lease;
    frozenRef.current = live;
  } else if (
    live.previewLine ||
    live.answerText ||
    live.citations.length > 0 ||
    live.activeTool ||
    live.completed ||
    live.turnFailed
  ) {
    frozenRef.current = live;
  }
  const content = frozenRef.current;
  const [answerOpen, setAnswerOpen] = useState(false);
  // 运行中图标语义：只要回合没收口（completed=false）就转圈——
  // 有正文/有引用也不换星星，避免用户误以为任务已完成（线上反馈图二）。
  const busy = status === "running" && !content.completed && !content.turnFailed;
  const failed = status === "failed" || content.turnFailed;
  const toolText = useMemo(
    () =>
      content.activeTool
        ? describeAiSearchTool(content.activeTool, format)
        : null,
    [content.activeTool, format],
  );
  const turnErrorText = content.turnError ?? query;
  const firstLine = failed
    ? (status === "failed" ? (error ?? query) : turnErrorText)
    : content.previewLine || format({ id: "commandCenter.aiSearch.running" });
  // 全文入口与来源只在回合收口后出现：运行中不存在「最后一条」的概念，
  // 中间引用也不是最终答案的依据（线上反馈图一、图二）。
  const showFinal = content.completed && !failed;
  const handleOpenExternalUrl = useCallback(
    (url: string) => platform?.openExternal(url),
    [platform],
  );
  return (
    <div className="px-3 py-2">
      {/* 顶部过程区：第一行正文预览 + 第二行工具调用，常驻不消失。 */}
      <div className="flex items-center gap-2 py-1 text-ui-base">
        {busy && !failed ? (
          <span className="size-3.5 shrink-0 animate-spin rounded-full border border-border border-t-foreground-subtle" />
        ) : (
          <SparklesIcon className="size-3.5 shrink-0 text-brand" />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate leading-5",
            failed ? "text-destructive" : content.previewLine ? "text-foreground" : "text-foreground-subtle",
          )}
        >
          {firstLine}
        </span>
        {status === "running" ? (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-md px-2 py-0.5 text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          >
            Esc
          </button>
        ) : null}
      </div>
      {toolText ? (
        <div className="flex items-center gap-2 py-0.5 pl-[22px] text-ui-base">
          <HistoryIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
          <span
            className={cn(
              "shrink-0 font-medium whitespace-nowrap",
              toolText.running ? "animated-gradient-text" : "text-foreground-subtlest",
            )}
          >
            {toolText.kind}
          </span>
          {toolText.summary ? (
            <span className="min-w-0 flex-1 truncate text-foreground-subtlest">{toolText.summary}</span>
          ) : null}
        </div>
      ) : null}
      {failed ? (
        <div className="px-[22px] py-1">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-7 w-fit items-center rounded-full border border-border px-3 text-ui-base font-medium text-foreground hover:bg-surface-hover"
          >
            {format({ id: "commandCenter.aiSearch.retry" })}
          </button>
        </div>
      ) : null}
      {/* 归纳正文：仅回合收口后出现，默认收起看最后一条完成消息。 */}
      {showFinal && content.answerText ? (
        <div className="py-0.5">
          <button
            type="button"
            aria-expanded={answerOpen}
            aria-label={format({
              id: answerOpen
                ? "commandCenter.aiSearch.collapseAnswer"
                : "commandCenter.aiSearch.expandAnswer",
            })}
            onClick={() => setAnswerOpen((value) => !value)}
            className="flex w-full items-center gap-1.5 rounded-xl px-2 py-1 text-left text-ui-base text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", answerOpen ? "rotate-180" : "")}
            />
            <span>
              {format({
                id: answerOpen
                  ? "commandCenter.aiSearch.collapseAnswer"
                  : "commandCenter.aiSearch.expandAnswer",
              })}
            </span>
          </button>
          {answerOpen ? (
            <div className="px-2 py-1 text-foreground">
              <MessageResponse
                workspacePath={workspaceAbsPath}
                workspaceIdentity={workspaceIdentity}
                theme={theme}
                codePreviewSettings={codePreviewSettings}
                onOpenCodeViewer={onOpenCodeViewer}
                onOpenExternalUrl={handleOpenExternalUrl}
              >
                {content.answerText}
              </MessageResponse>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* 来源列表：仅回合收口后出现，与普通关键词任务行同一套 CommandItem 样式。 */}
      {showFinal && content.citations.length > 0 ? (
        <CommandGroup heading={format({ id: "commandCenter.aiSearch.sources" })}>
          {content.citations.map((citation) => (
            <AiSearchCitationRow
              key={`${citation.sessionId}:${citation.segment}`}
              citation={citation}
              query={query}
              workspaceLabel={workspaceLabel}
              onJumpToCitation={onJumpToCitation}
            />
          ))}
        </CommandGroup>
      ) : null}
    </div>
  );
}

export const CommandCenterDialog = memo(function CommandCenterDialogComponent({
  open,
  commands,
  workspaceAbsPath,
  workspaceIdentity,
  activeTaskId,
  activeTaskChangeSummary,
  workspaceTabs,
  onOpenChange,
  onSelectTask,
  onSearchResultHighlightRequest,
  onOpenCodeViewer,
}: {
  open: boolean;
  commands: QuickPickCommand[];
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activeTaskId?: string | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  workspaceTabs: WorkspaceTabState[];
  onOpenChange: (open: boolean) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onSearchResultHighlightRequest?: (
    request: Omit<ChatSearchResultHighlightRequest, "requestId">,
  ) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
}) {
  const { fileService, zcodeAgentService } = useServices();
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const [rawQuery, setRawQuery] = useState("");
  // AI 搜索回答态：true 时列表换成回答区（spec: docs/specs/command-center-ai-history-search.md）。
  // 改搜索框里的字即回到结果列表（新搜索意图，非追问）；关浮层即取消并回收。
  const [aiAnswerOpen, setAiAnswerOpen] = useState(false);
  const aiSearch = useAiHistorySearchRunner({
    workspaceAbsPath,
    workspaceIdentity,
    agentService: zcodeAgentService ?? null,
  });
  const [manualScope, setManualScope] = useState<CommandCenterSearchScope>("all");
  // 「仅标题」开关（spec: specs/command-center-search.md）：只影响任务分区匹配，
  // 关闭弹窗时随 manualScope 一起重置，不进搜索历史。
  const [titlesOnly, setTitlesOnly] = useState(false);
  // 「包含已归档」开关（spec: specs/command-center-search.md）：打开后归档会话参与搜索。
  // 与「仅标题」刻意不同：按 workspaceKey 持久化用户选择，跨弹窗保留，不随关闭重置。
  const [includeArchived, setIncludeArchived] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<CommandCenterSectionId>>(
    () => new Set(),
  );
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<CommandCenterSearchHistoryEntry[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  const [workspaceFilesError, setWorkspaceFilesError] = useState<string | null>(null);
  const [loadedWorkspaceKey, setLoadedWorkspaceKey] = useState<string | null>(null);
  // 性能修复：Command Center 关闭时不需要跟随 chat streaming 重算命令、任务和 recent changes。
  // 保留 hooks 顺序，但把关闭态输入降为空，避免隐藏弹窗在每个 token 批次重建结果区。
  const effectiveCommands = open ? commands : EMPTY_QUICK_PICK_COMMANDS;
  const effectiveWorkspaceTabs = open ? workspaceTabs : EMPTY_COMMAND_CENTER_WORKSPACE_TABS;
  const effectiveActiveTaskChangeSummary = open ? activeTaskChangeSummary : null;
  // 输入防抖（闪烁修复）：连续输入过程中查询不触发，所有搜索派生状态
  // （scope 解析、任务/文件查询、分组渲染）都跟防抖后的值走；loading 只在输入框内展示。
  const [debouncedRawQuery, setDebouncedRawQuery] = useState(rawQuery);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedRawQuery(rawQuery), 200);
    return () => clearTimeout(timer);
  }, [rawQuery]);
  const isDebouncing = debouncedRawQuery !== rawQuery;
  const debouncedResolvedQuery = useMemo(
    () => resolveQueryScope(debouncedRawQuery),
    [debouncedRawQuery],
  );
  const activeScope = debouncedResolvedQuery.explicitScope
    ? debouncedResolvedQuery.scope
    : manualScope;
  const searchQuery = debouncedResolvedQuery.query;
  const hasSearchQuery = searchQuery.trim().length > 0;
  const searchConversations =
    open && hasSearchQuery && (activeScope === "all" || activeScope === "conversations");
  const searchFiles = open && hasSearchQuery && (activeScope === "all" || activeScope === "files");
  const searchWorkspaceTabs = useMemo(
    () => (searchConversations ? effectiveWorkspaceTabs : []),
    [effectiveWorkspaceTabs, searchConversations],
  );
  const currentWorkspaceTabs = useMemo(
    () =>
      effectiveWorkspaceTabs.filter(
        (tab) => (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
      ),
    [effectiveWorkspaceTabs, workspaceKey],
  );
  const recentTaskWorkspaceTabs = useMemo(
    () => (open && !hasSearchQuery ? currentWorkspaceTabs : []),
    [currentWorkspaceTabs, hasSearchQuery, open],
  );
  const taskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: searchWorkspaceTabs,
    sortBy: "updated",
    searchQuery,
    searchTitlesOnly: titlesOnly,
    includeArchived,
    expanded: false,
    collapsedLimit: COMMAND_CENTER_TASK_RESULT_LIMIT,
  });
  const recentTaskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: recentTaskWorkspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: false,
    collapsedLimit:
      activeScope === "conversations"
        ? COMMAND_CENTER_TASK_RESULT_LIMIT + (activeTaskId ? 1 : 0)
        : COMMAND_CENTER_CONTEXT_SECTION_LIMIT + (activeTaskId ? 1 : 0),
  });
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        effectiveWorkspaceTabs.map((tab) => [
          tab.workspaceIdentity?.trim() || tab.workspacePath,
          tab.label,
        ]),
      ),
    [effectiveWorkspaceTabs],
  );
  const commandOptions = useMemo(
    () =>
      effectiveCommands
        .map((command) => ({
          command,
          title: intl.formatMessage({ id: command.titleId }),
        }))
        .filter(({ command, title }) => matchesCommand(command, title, searchQuery)),
    [effectiveCommands, intl, searchQuery],
  );
  const commandOptionsBySection = useMemo(
    () =>
      QUICK_PICK_SECTION_ORDER.map((sectionId) => ({
        sectionId,
        commands: commandOptions.filter(({ command }) => command.sectionId === sectionId),
      })).filter((section) => section.commands.length > 0),
    [commandOptions],
  );
  const conversationRows = useMemo(
    () => buildTaskResultRows({ tasks: taskList.items, query: searchQuery }),
    [searchQuery, taskList.items],
  );
  const fileRows = useMemo(
    () => filterWorkspaceFileEntries(workspaceFiles, searchQuery),
    [searchQuery, workspaceFiles],
  );
  const recentChangeRows = useMemo(
    () => [...(effectiveActiveTaskChangeSummary?.files ?? [])].sort(compareRecentChangedFiles),
    [effectiveActiveTaskChangeSummary],
  );
  const recentChangePreviewRows = useMemo(
    () => recentChangeRows.slice(0, COMMAND_CENTER_CONTEXT_SECTION_LIMIT),
    [recentChangeRows],
  );
  const recentTaskRows = useMemo(
    () => recentTaskList.items.filter((task) => task.taskId !== activeTaskId),
    [activeTaskId, recentTaskList.items],
  );
  const recentTaskPreviewRows = useMemo(
    () => recentTaskRows.slice(0, COMMAND_CENTER_CONTEXT_SECTION_LIMIT),
    [recentTaskRows],
  );
  const aiSearchCancelRef = useRef(aiSearch.cancel);
  aiSearchCancelRef.current = aiSearch.cancel;
  useEffect(() => {
    if (open) {
      setHistoryEntries(readCommandCenterSearchHistory(workspaceKey));
      // 「包含已归档」按 workspaceKey 恢复上次选择（spec 验收场景 10）；
      // 刻意不加入下方关闭分支的重置列表——那是「仅标题」的规则。
      setIncludeArchived(readCommandCenterIncludeArchived(workspaceKey));
      return;
    }

    setRawQuery("");
    setManualScope("all");
    setTitlesOnly(false);
    setExpandedSections(new Set());
    setHistoryExpanded(false);
    // 关浮层等于取消并回收隐藏会话（spec 失败语义）。
    setAiAnswerOpen(false);
    aiSearchCancelRef.current();
  }, [open, workspaceKey]);

  useEffect(() => {
    setExpandedSections(new Set());
  }, [activeScope, searchQuery]);

  useEffect(() => {
    setWorkspaceFiles([]);
    setWorkspaceFilesError(null);
    setWorkspaceFilesLoading(false);
    setLoadedWorkspaceKey(null);
  }, [workspaceKey]);

  useEffect(() => {
    if (!searchFiles || loadedWorkspaceKey === workspaceKey) {
      return;
    }

    let cancelled = false;
    setWorkspaceFilesLoading(true);
    setWorkspaceFilesError(null);
    void fetchWorkspaceFileEntriesPacked(fileService, workspaceAbsPath)
      .then((result) => {
        // Host 返回列式 packed 字符串（避免大数组结构化克隆），此处一次性解包。
        const entries = unpackWorkspaceFileEntries(result, workspaceAbsPath);
        if (cancelled) {
          return;
        }

        setWorkspaceFiles(entries);
        setLoadedWorkspaceKey(workspaceKey);
      })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceFilesError(String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkspaceFilesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileService, loadedWorkspaceKey, searchFiles, workspaceAbsPath, workspaceKey]);

  const rememberSearch = useCallback(
    (scope: CommandCenterSearchScope = activeScope) => {
      if (!hasSearchQuery) {
        return;
      }

      setHistoryEntries(
        pushCommandCenterSearchHistory({
          workspaceKey,
          query: searchQuery,
          scope,
        }),
      );
    },
    [activeScope, hasSearchQuery, searchQuery, workspaceKey],
  );

  const closeDialog = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // 发起 AI 搜索：列表换成回答区，同一浮层内呈现状态 + 归纳 + 来源。
  const startAiSearch = useCallback(() => {
    if (!hasSearchQuery) return;
    setAiAnswerOpen(true);
    aiSearch.start(searchQuery);
  }, [aiSearch, hasSearchQuery, searchQuery]);

  // 改搜索框里的字：取消当前运行（若还在跑），回到结果列表（新搜索意图，非追问）。
  const handleQueryChange = useCallback(
    (value: string) => {
      if (aiAnswerOpen) {
        setAiAnswerOpen(false);
        aiSearch.reset();
      }
      setRawQuery(value);
    },
    [aiAnswerOpen, aiSearch],
  );

  const runCommand = useCallback(
    (command: QuickPickCommand) => {
      rememberSearch("commands");
      closeDialog();
      void Promise.resolve(command.run()).catch((error) => {
        logger.error("[CommandCenter] 命令执行失败", {
          commandId: command.id,
          error,
        });
        toast(
          intl.formatMessage(
            { id: "quickPick.commandFailed" },
            {
              error: error instanceof Error ? error.message : String(error),
            },
          ),
        );
      });
    },
    [closeDialog, intl, rememberSearch],
  );

  const selectTask = useCallback(
    (row: TaskSearchResultRow) => {
      rememberSearch("conversations");
      onSearchResultHighlightRequest?.({
        taskId: row.task.taskId,
        workspacePath: row.task.workspacePath,
        workspaceIdentity: row.task.workspaceIdentity,
        query: searchQuery,
        snippet: row.searchSnippet?.trim() || row.task.searchSnippet?.trim() || undefined,
        snippetIndex: row.snippetIndex,
      });
      onSelectTask(row.task.workspacePath, row.task.taskId, row.task.workspaceIdentity);
      closeDialog();
    },
    [closeDialog, onSearchResultHighlightRequest, onSelectTask, rememberSearch, searchQuery],
  );

  const selectFile = useCallback(
    (entry: WorkspaceFileEntry) => {
      rememberSearch("files");
      onOpenCodeViewer({
        type: "file",
        title: entry.name,
        path: entry.path,
      });
      closeDialog();
    },
    [closeDialog, onOpenCodeViewer, rememberSearch],
  );

  const selectRecentChange = useCallback(
    (file: TaskChangedFileSummary) => {
      closeDialog();
      const relativePath = toWorkspaceRelativePath(workspaceAbsPath, file.path);
      onOpenCodeViewer({
        type: "file",
        title: getPathLeaf(relativePath) || relativePath,
        path: file.path,
      });
    },
    [closeDialog, onOpenCodeViewer, workspaceAbsPath],
  );

  const selectRecentTask = useCallback(
    (task: ZCodeTaskMeta) => {
      onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
      closeDialog();
    },
    [closeDialog, onSelectTask],
  );

  // 点来源跳走：关浮层，切到目标任务并按摘录高亮（与点关键词任务行同一链路）；
  // 当前正在跑的对话不被这次搜索打断。摘录的【】标记去掉后参与定位。
  // AI 搜索作用域限当前聚焦工作区，目标会话的 workspace 即当前工作区。
  const jumpToAiCitation = useCallback(
    (citation: AiSearchCitation) => {
      const snippet = citationJumpText(citation.snippet);
      onSearchResultHighlightRequest?.({
        taskId: citation.sessionId,
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        query: searchQuery,
        snippet: snippet || undefined,
      });
      onSelectTask(workspaceAbsPath, citation.sessionId, workspaceIdentity);
      closeDialog();
    },
    [
      closeDialog,
      onSearchResultHighlightRequest,
      onSelectTask,
      searchQuery,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );

  const setScope = useCallback(
    (scope: CommandCenterSearchScope) => {
      setManualScope(scope);
      if (debouncedResolvedQuery.explicitScope) {
        setRawQuery(searchQuery);
      }
    },
    [debouncedResolvedQuery.explicitScope, searchQuery],
  );

  const shouldShowCommandSection = activeScope === "all" || activeScope === "commands";
  const shouldShowConversationSection = activeScope === "all" || activeScope === "conversations";
  const shouldShowFileSection = activeScope === "all" || activeScope === "files";
  const showHistory = !hasSearchQuery && historyEntries.length > 0;

  const renderMoreRow = (sectionId: CommandCenterSectionId, count: number) => {
    if (expandedSections.has(sectionId) || count <= COMMAND_CENTER_SECTION_LIMIT) {
      return null;
    }

    return (
      <button
        type="button"
        className="mt-0.5 flex min-h-7 w-full items-center gap-1.5 rounded-xl px-2.5 pl-8 text-left text-ui-base text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
        onClick={() => setExpandedSections((current) => new Set(current).add(sectionId))}
      >
        {intl.formatMessage({ id: "commandCenter.moreResults" })}
        <ChevronDownIcon className="size-3.5" />
      </button>
    );
  };

  const renderRecentChangesSection = ({
    rows = recentChangePreviewRows,
    showEmpty = false,
  }: {
    rows?: TaskChangedFileSummary[];
    showEmpty?: boolean;
  } = {}) => {
    if (hasSearchQuery || (rows.length === 0 && !showEmpty)) {
      return null;
    }

    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.recentChanges" })}>
        {rows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.empty.recentChanges" })}
          </CommandEmpty>
        ) : null}
        {rows.map((file) => {
          const relativePath = toWorkspaceRelativePath(workspaceAbsPath, file.path);
          const descriptor = resolveFileDisplayDescriptor(file.path);
          return (
            <CommandItem
              key={file.path}
              value={`${relativePath} +${file.added} -${file.removed}`}
              className={quickPickItemClassName}
              onSelect={() => selectRecentChange(file)}
            >
              <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{relativePath}</span>
              <CommandShortcut className={quickPickMetadataClassName}>
                <span className="text-diff-added">+{file.added}</span>{" "}
                <span className="text-diff-removed">-{file.removed}</span>
              </CommandShortcut>
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  };

  const renderRecentTasksSection = ({
    rows = recentTaskPreviewRows,
    showEmpty = false,
  }: {
    rows?: ZCodeTaskMeta[];
    showEmpty?: boolean;
  } = {}) => {    if (hasSearchQuery || (rows.length === 0 && !showEmpty)) {
      return null;
    }

    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.recentTasks" })}>
        {rows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.empty.recentTasks" })}
          </CommandEmpty>
        ) : null}
        {rows.map((task) => {
          const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
          return (
            <CommandItem
              key={`${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`}
              value={`${title} ${task.workspacePath}`}
              className={quickPickItemClassName}
              onSelect={() => selectRecentTask(task)}
            >
              <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <CommandShortcut className={quickPickMetadataClassName}>
                {formatTaskRelativeTime(task.updatedAt, intl)}
              </CommandShortcut>
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  };

  // 「用 AI 搜索」触发项：有查询时列表最上面一项，与任务/文件行同一套列表样式，
  // 排在关键词分区之前；cmdk 默认高亮第一项，回车即发起（spec 界面呈现）。
  // 空查询不出现；无关键词命中时空状态退到它下面。
  const renderAiSearchTrigger = () => {
    if (!hasSearchQuery) return null;
    return (
      <CommandGroup>
        <CommandItem
          value="ai-search"
          className={quickPickItemClassName}
          onSelect={startAiSearch}
        >
          <SparklesIcon className="size-3.5 text-brand" />
          <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
            <span className="truncate text-ui-base leading-5 font-normal text-foreground">
              {intl.formatMessage({ id: "commandCenter.aiSearch.item" }, { query: searchQuery })}
            </span>
            <span className="min-w-0 truncate text-ui-base leading-4 text-foreground-subtle">
              {intl.formatMessage({ id: "commandCenter.aiSearch.hint" })}
            </span>
          </span>
          <CommandShortcut className={quickPickShortcutPillClassName}>↵</CommandShortcut>
        </CommandItem>
      </CommandGroup>
    );
  };

  const renderCommandSections = () => {
    if (!shouldShowCommandSection || commandOptionsBySection.length === 0) {
      return null;
    }

    return commandOptionsBySection.map((section) => (
      <CommandGroup
        key={section.sectionId}
        heading={intl.formatMessage({
          id: `quickPick.section.${section.sectionId}`,
        })}
      >
        {section.commands.map(({ command, title }) => {
          const Icon = QUICK_PICK_ICON_BY_KIND[command.icon];
          return (
            <CommandItem
              key={command.id}
              value={`${title} ${command.keywords.join(" ")}`}
              disabled={command.disabled}
              className={quickPickItemClassName}
              onSelect={() => runCommand(command)}
            >
              <Icon className="size-3.5 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">
                <HighlightedMatchText text={title} query={searchQuery} />
              </span>
              {command.shortcut ? (
                <CommandShortcut className={quickPickShortcutPillClassName}>
                  {command.shortcut}
                </CommandShortcut>
              ) : null}
            </CommandItem>
          );
        })}
      </CommandGroup>
    ));
  };

  const renderConversationSection = () => {
    if (
      !hasSearchQuery ||
      !shouldShowConversationSection ||
      (!taskList.loading && conversationRows.length === 0)
    ) {
      return null;
    }

    const visibleRows =
      activeScope === "conversations" || expandedSections.has("conversations")
        ? conversationRows
        : conversationRows.slice(0, COMMAND_CENTER_SECTION_LIMIT);
    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.conversations" })}>
        {visibleRows.map((row) => {
          const task = row.task;
          const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
          const workspaceLabel =
            workspaceLabelByKey.get(task.workspaceIdentity?.trim() || task.workspacePath) ??
            task.workspacePath;
          const searchSnippet = row.searchSnippet?.trim();
          return (
            <CommandItem
              key={row.key}
              value={`${title} ${workspaceLabel} ${searchSnippet ?? ""}`}
              className={quickPickItemClassName}
              onSelect={() => selectTask(row)}
            >
              <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
              <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
                <span className="truncate text-ui-base leading-5 font-normal text-foreground">
                  <HighlightedMatchText text={title} query={searchQuery} />
                </span>
                {searchSnippet ? (
                  <span className="min-w-0 truncate text-ui-base leading-4 text-foreground-subtle">
                    <HighlightedMatchText text={searchSnippet} query={searchQuery} />
                  </span>
                ) : null}
              </span>
              <CommandShortcut className={quickPickMetadataClassName}>
                {workspaceLabel}
              </CommandShortcut>
              {task.archived === true ? (
                <span
                  className={cn(quickPickShortcutPillClassName, "shrink-0")}
                  title={intl.formatMessage({ id: "commandCenter.archivedBadge" })}
                >
                  {intl.formatMessage({ id: "commandCenter.archivedBadge" })}
                </span>
              ) : null}
              {row.extraSnippetCount > 0 ? (
                <span
                  className={cn(quickPickShortcutPillClassName, "shrink-0")}
                  title={intl.formatMessage(
                    { id: "commandCenter.moreSnippetMatches" },
                    { count: row.extraSnippetCount },
                  )}
                >
                  +{row.extraSnippetCount}
                </span>
              ) : null}
              <CommandCenterConversationTimestamp>
                {formatTaskRelativeTime(task.updatedAt, intl)}
              </CommandCenterConversationTimestamp>
            </CommandItem>
          );
        })}
        {activeScope === "all" ? renderMoreRow("conversations", conversationRows.length) : null}
      </CommandGroup>
    );
  };

  const renderFileSection = () => {
    if (
      !hasSearchQuery ||
      !shouldShowFileSection ||
      (!workspaceFilesLoading && !workspaceFilesError && fileRows.length === 0)
    ) {
      return null;
    }

    const visibleRows =
      activeScope === "files" || expandedSections.has("files")
        ? fileRows
        : fileRows.slice(0, COMMAND_CENTER_SECTION_LIMIT);
    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.files" })}>
        {workspaceFilesError ? (
          <CommandEmpty className="px-4 py-5 text-destructive">{workspaceFilesError}</CommandEmpty>
        ) : null}
        {visibleRows.map((entry) => {
          const descriptor = resolveFileDisplayDescriptor(entry.path);
          const directory = getWorkspaceFileDirectory(entry);
          return (
            <CommandItem
              key={entry.path}
              value={`${entry.name} ${entry.relativePath}`}
              className={quickPickItemClassName}
              onSelect={() => selectFile(entry)}
            >
              <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                <HighlightedMatchText text={entry.name} query={searchQuery} />
              </span>
              {directory ? (
                <CommandShortcut className={quickPickMetadataClassName}>
                  <HighlightedMatchText text={directory} query={searchQuery} />
                </CommandShortcut>
              ) : null}
            </CommandItem>
          );
        })}
        {activeScope === "all" ? renderMoreRow("files", fileRows.length) : null}
      </CommandGroup>
    );
  };

  const hasAnySearchResults =
    (shouldShowCommandSection && commandOptions.length > 0) ||
    (shouldShowConversationSection && conversationRows.length > 0) ||
    (shouldShowFileSection && fileRows.length > 0);
  const hasSearchStatus =
    taskList.loading ||
    workspaceFilesLoading ||
    (shouldShowFileSection && Boolean(workspaceFilesError));

  const renderDefaultSections = () => {
    switch (activeScope) {
      case "commands":
        return renderCommandSections();
      case "conversations":
        return renderRecentTasksSection({ rows: recentTaskRows, showEmpty: true });
      case "files":
        return renderRecentChangesSection({ rows: recentChangeRows, showEmpty: true });
      default:
        return (
          <>
            {renderRecentChangesSection()}
            {renderRecentTasksSection()}
            {renderCommandSections()}
          </>
        );
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage({ id: "quickPick.title" })}
      description={intl.formatMessage({ id: "quickPick.description" })}
      className={commandCenterDialogClassName}
    >
      <Command shouldFilter={false} loop className={quickPickCommandClassName}>
        <div className="border-b border-border px-2 pt-2 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-full border border-input-border bg-input px-2.5 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
            <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            <CommandPrimitive.Input
              value={rawQuery}
              onValueChange={handleQueryChange}
              placeholder={intl.formatMessage({ id: "commandCenter.placeholder" })}
              className="min-w-0 flex-1 bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest"
            />
            {hasSearchQuery && (isDebouncing || taskList.loading || workspaceFilesLoading) ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin text-foreground-subtlest" />
            ) : null}
          </div>
          {/* 回答态收起范围标签：此时不在筛关键词，避免误导（spec 界面呈现）。 */}
          {aiAnswerOpen ? null : (
          <div className="-mx-1 mt-1.5 flex items-center gap-1 px-1 pb-0.5">
            <div
              role="tablist"
              aria-label={intl.formatMessage({ id: "commandCenter.scopeTabs" })}
              className="flex min-w-0 gap-1 overflow-x-auto scrollbar-hide"
            >
              <CommandCenterScopeButton
                active={activeScope === "all"}
                label={intl.formatMessage({ id: "commandCenter.scope.all" })}
                onClick={() => setScope("all")}
              >
                <ListIcon className="size-3" />
              </CommandCenterScopeButton>
              <CommandCenterScopeButton
                active={activeScope === "commands"}
                label={intl.formatMessage({ id: "commandCenter.scope.commands" })}
                onClick={() => setScope("commands")}
              >
                <RocketIcon className="size-3" />
              </CommandCenterScopeButton>
              <CommandCenterScopeButton
                active={activeScope === "conversations"}
                label={intl.formatMessage({ id: "commandCenter.scope.conversations" })}
                onClick={() => setScope("conversations")}
              >
                <MessagesSquareIcon className="size-3" />
              </CommandCenterScopeButton>
              <CommandCenterScopeButton
                active={activeScope === "files"}
                label={intl.formatMessage({ id: "commandCenter.scope.files" })}
                onClick={() => setScope("files")}
              >
                <FileIcon className="size-3" />
              </CommandCenterScopeButton>
            </div>
            {/* 「仅标题」「包含已归档」开关不属于 tab，放在 tablist 外右侧避免破坏 tablist 语义。 */}
            {(activeScope === "all" || activeScope === "conversations") && (
              <>
                <button
                  type="button"
                  role="switch"
                  aria-checked={titlesOnly}
                  aria-label={intl.formatMessage({ id: "commandCenter.searchTitlesOnly" })}
                  title={intl.formatMessage({ id: "commandCenter.searchTitlesOnly" })}
                  onClick={() => setTitlesOnly((value) => !value)}
                  className={cn(commandCenterScopeChipClassName(titlesOnly), "ml-auto")}
                >
                  <span>{intl.formatMessage({ id: "commandCenter.searchTitlesOnly" })}</span>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={includeArchived}
                  aria-label={intl.formatMessage({ id: "commandCenter.searchIncludeArchived" })}
                  title={intl.formatMessage({ id: "commandCenter.searchIncludeArchived" })}
                  onClick={() => {
                    const next = !includeArchived;
                    setIncludeArchived(next);
                    // 切换即写持久化：按 workspaceKey 记住用户的搜索习惯。
                    writeCommandCenterIncludeArchived(workspaceKey, next);
                  }}
                  className={commandCenterScopeChipClassName(includeArchived)}
                >
                  <span>{intl.formatMessage({ id: "commandCenter.searchIncludeArchived" })}</span>
                </button>
              </>
            )}
          </div>
          )}
        </div>
        <CommandList className={commandCenterListClassName}>
          {aiAnswerOpen ? (
            <CommandCenterAiAnswer
              query={searchQuery}
              status={aiSearch.status}
              error={aiSearch.error}
              lease={aiSearch.projectionLease}
              workspaceAbsPath={workspaceAbsPath}
              workspaceIdentity={workspaceIdentity}
              workspaceLabel={workspaceLabelByKey.get(workspaceKey) ?? workspaceAbsPath}
              onRetry={startAiSearch}
              onCancel={aiSearch.cancel}
              onJumpToCitation={jumpToAiCitation}
              onOpenCodeViewer={onOpenCodeViewer}
            />
          ) : !hasSearchQuery ? (
            renderDefaultSections()
          ) : (
            <>
              {renderAiSearchTrigger()}
              {hasAnySearchResults || hasSearchStatus ? (
                <>
                  {renderCommandSections()}
                  {renderConversationSection()}
                  {renderFileSection()}
                </>
              ) : (
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {intl.formatMessage({ id: "commandCenter.noResults" })}
                </CommandEmpty>
              )}
            </>
          )}
        </CommandList>
        {showHistory ? (
          <CommandCenterSearchHistory
            entries={historyEntries}
            expanded={historyExpanded}
            onToggleExpanded={() => setHistoryExpanded((value) => !value)}
            onPickEntry={(entry) => {
              const prefix = scopeToPrefix(entry.scope);
              setManualScope(entry.scope);
              setRawQuery(prefix ? `${prefix}${entry.query}` : entry.query);
            }}
            onClear={() => {
              clearCommandCenterSearchHistory(workspaceKey);
              setHistoryEntries([]);
            }}
            historyLabel={intl.formatMessage({ id: "commandCenter.history" })}
            clearLabel={intl.formatMessage({ id: "commandCenter.clearHistory" })}
            expandLabel={intl.formatMessage({ id: "commandCenter.expandHistory" })}
            collapseLabel={intl.formatMessage({ id: "commandCenter.collapseHistory" })}
          />
        ) : null}
      </Command>
    </CommandDialog>
  );
});
