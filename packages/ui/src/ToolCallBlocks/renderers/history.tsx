import { History } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import type {
  ToolCallHistoryListDisplay,
  ToolCallHistoryReadDisplay,
  ToolCallHistorySearchDisplay,
} from "@zcode/shared/zcode-protocol-v4";

// ============================================================
// 会话存档三工具（HistoryList / HistorySearch / HistoryRead）的聊天卡
// ============================================================
// 折叠行是设计重心：一行结构化摘要（计数 / query / 标题 / 段坐标），数据来自 display
// 载荷，不解析文本投影；展开态直接渲染 wire 上已有的 output.text——那正是模型读到的
// 同一段文本。display 缺席（升级前 transcript、非 v4 宿主）时折叠行只剩 kindLabel，
// 不出 raw JSON、不报错。规则与字段表见 docs/specs/session-history-tools.md「聊天工具卡」。

const HISTORY_TOOL_ICON = <History className="size-4 shrink-0 text-foreground-subtle" />;

/** 摘要拼装只依赖 formatMessage 的最小面，方便纯函数单测。 */
export type HistorySummaryFormat = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 折叠行 query 预览的上限：一行摘要里 query 是主角但不能吞掉命中数。 */
const QUERY_PREVIEW_MAX_CHARS = 24;
const SESSION_ID_PREVIEW_CHARS = 18;

export function formatQueryPreview(query: string): string {
  const trimmed = query.trim();
  const chars = Array.from(trimmed);
  const preview =
    chars.length > QUERY_PREVIEW_MAX_CHARS
      ? `${chars.slice(0, QUERY_PREVIEW_MAX_CHARS).join("")}…`
      : trimmed;
  return `"${preview}"`;
}

function formatSessionIdPreview(sessionId: string): string {
  return sessionId.length > SESSION_ID_PREVIEW_CHARS
    ? `${sessionId.slice(0, SESSION_ID_PREVIEW_CHARS)}…`
    : sessionId;
}

export function historyListSummaryText(
  display: ToolCallHistoryListDisplay | undefined,
  format: HistorySummaryFormat,
): string | undefined {
  if (!display) return undefined;
  if (display.status === "failed") {
    return format({ id: "chat.toolCall.history.failed" });
  }
  if (display.sessionCount === 0) {
    return format({ id: "chat.toolCall.history.list.empty" });
  }
  const count = format(
    {
      id:
        display.sessionCount === 1
          ? "chat.toolCall.history.list.countOne"
          : "chat.toolCall.history.list.count",
    },
    { count: display.sessionCount },
  );
  const scopeNote = display.scopeNote?.trim();
  return scopeNote ? `${scopeNote} · ${count}` : count;
}

export function historySearchSummaryText(
  display: ToolCallHistorySearchDisplay | undefined,
  format: HistorySummaryFormat,
): string | undefined {
  if (!display) return undefined;
  if (display.status === "not_found") {
    return format({ id: "chat.toolCall.history.search.notFound" });
  }
  if (display.status === "failed") {
    return format({ id: "chat.toolCall.history.failed" });
  }
  const query = formatQueryPreview(display.query);
  if (display.hitCount === 0) {
    return format({ id: "chat.toolCall.history.search.noHits" }, { query });
  }
  const count = format(
    {
      id:
        display.hitCount === 1
          ? "chat.toolCall.history.search.countOne"
          : "chat.toolCall.history.search.count",
    },
    { count: display.hitCount },
  );
  return `${query} · ${count}`;
}

export function historyReadSummaryText(
  display: ToolCallHistoryReadDisplay | undefined,
  format: HistorySummaryFormat,
): string | undefined {
  if (!display) return undefined;
  if (display.status === "not_found") {
    return format({ id: "chat.toolCall.history.read.notFound" });
  }
  if (display.status === "failed") {
    return format({ id: "chat.toolCall.history.failed" });
  }
  // 折叠行只回答「读了哪个会话」：标题或 sessionId，不堆段坐标等细节（展开态有全文）。
  const title = display.title?.trim();
  return title
    ? format({ id: "chat.toolCall.history.read.titled" }, { title })
    : formatSessionIdPreview(display.sessionId);
}

/**
 * query 的输入兜底：query 在 toolCall.input 里，结果回来前（运行中）与 display 载荷缺席
 * （旧构建 CLI、升级前 transcript）时也能给出「搜的是什么」。display 在场时仍以它为准
 * （带命中数），这里只补一个纯关键词。
 */
export function readSearchQueryFromInput(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return undefined;
  const query = input.query;
  if (typeof query !== "string" || query.trim().length === 0) return undefined;
  return query;
}

/**
 * 展开态文本：v4 wire 的 output.text 是 formatModelContent 投影（模型读到的同一段）。
 * 桌面/UI 适配层通常已把它折进 toolCall.output 字符串；这里对 raw 侧的 { text } 形态
 * 再兜一层，两条路都没有就放弃展开（不出 raw JSON）。
 */
function readTextProjection(toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"]) {
  if (typeof toolCall.output === "string" && toolCall.output.trim().length > 0) {
    return toolCall.output;
  }
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  for (const candidate of [raw?.rawOutput, raw?.output, raw?.result]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
    if (isPlainRecord(candidate) && typeof candidate.text === "string" && candidate.text.trim().length > 0) {
      return candidate.text;
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function HistoryTextProjection({ text }: { text: string }) {
  return (
    <pre className="mb-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 font-mono text-ui-base text-foreground-subtle">
      {text}
    </pre>
  );
}

function HistoryCardShell(props: {
  context: ToolCallBlockRenderContext;
  kindLabel: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  renderContent?: () => ReactNode;
  hasDetails: boolean;
}) {
  const { toolCall } = props.context.toolCallNode;
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={HISTORY_TOOL_ICON}
        showIcon={props.context.showIcon !== false}
        canToggle={props.hasDetails && (props.context.canToggle ?? true)}
        forceOpen={props.hasDetails && (props.context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={props.context.kindLabelOverride ?? props.kindLabel}
        sourceLabel={props.context.sourceLabel}
        primaryText={props.primaryText}
        secondaryText={props.secondaryText}
        statusLabel={toolCall.status === "failed" ? props.context.statusLabel : undefined}
        statusTooltip={toolCall.status === "failed" ? props.context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={props.context.isRunning}
        title={toolCall.title}
        renderContent={props.hasDetails ? props.renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          props.context.onLoadFullToolCallFields
            ? () => props.context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}

const SUMMARY_TEXT_CLASS = "truncate text-foreground-subtlest";

/** HistoryList：折叠行 = scopeNote · N 个会话；展开 = 会话清单文本投影。 */
export function HistoryListToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const listDisplay = display?.kind === "history_list" ? display : undefined;
  const text = useMemo(() => readTextProjection(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.history.list.listing"
      : "chat.toolCall.history.list.listed",
  });
  const summary = useMemo(
    () => historyListSummaryText(listDisplay, intl.formatMessage),
    [intl, listDisplay],
  );
  const primaryText = useMemo(
    () => <span className={SUMMARY_TEXT_CLASS}>{summary}</span>,
    [summary],
  );

  return (
    <HistoryCardShell
      context={context}
      kindLabel={kindLabel}
      primaryText={primaryText}
      hasDetails={text !== undefined}
      renderContent={text === undefined ? undefined : () => <HistoryTextProjection text={text} />}
    />
  );
}

/** HistorySearch：折叠行 = "query" · N 个命中；展开 = 命中片段文本投影 + truncated 尾注。 */
export function HistorySearchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const searchDisplay = display?.kind === "history_search" ? display : undefined;
  const text = useMemo(() => readTextProjection(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.history.search.searching"
      : "chat.toolCall.history.search.searched",
  });
  const inputQuery = useMemo(() => readSearchQueryFromInput(toolCall.input), [toolCall.input]);
  const summary = useMemo(
    () =>
      // display 缺席（运行中 / 旧构建 CLI / 升级前 transcript）时退回输入侧的纯关键词，
      // 「搜的是什么」永远在折叠行上；display 在场时它自带 query + 命中数。
      historySearchSummaryText(searchDisplay, intl.formatMessage) ??
      (inputQuery === undefined ? undefined : formatQueryPreview(inputQuery)),
    [intl, inputQuery, searchDisplay],
  );
  const primaryText = useMemo(
    () => <span className={SUMMARY_TEXT_CLASS}>{summary}</span>,
    [summary],
  );

  const renderContent = useMemo(() => {
    if (text === undefined) return undefined;
    return () => (
      <div className="mb-2 space-y-2">
        <HistoryTextProjection text={text} />
        {searchDisplay?.truncated === true ? (
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.history.search.truncated" })}
          </p>
        ) : null}
      </div>
    );
  }, [intl, searchDisplay, text]);

  return (
    <HistoryCardShell
      context={context}
      kindLabel={kindLabel}
      primaryText={primaryText}
      hasDetails={text !== undefined}
      renderContent={renderContent}
    />
  );
}

/** HistoryRead：折叠行 = 《标题》或 sessionId（只回答读了哪个会话）；展开 = 原文投影。 */
export function HistoryReadToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const readDisplay = display?.kind === "history_read" ? display : undefined;
  const text = useMemo(() => readTextProjection(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.history.read.reading"
      : "chat.toolCall.history.read.read",
  });
  const summary = useMemo(
    () => historyReadSummaryText(readDisplay, intl.formatMessage),
    [intl, readDisplay],
  );
  const primaryText = useMemo(
    () => <span className={SUMMARY_TEXT_CLASS}>{summary}</span>,
    [summary],
  );
  const secondaryText = useMemo(
    () =>
      readDisplay ? (
        <code className="min-w-0 truncate rounded-md bg-surface px-1.5 py-0.5 font-mono text-ui-base text-foreground-subtle">
          {formatSessionIdPreview(readDisplay.sessionId)}
        </code>
      ) : undefined,
    [readDisplay],
  );

  return (
    <HistoryCardShell
      context={context}
      kindLabel={kindLabel}
      primaryText={primaryText}
      secondaryText={secondaryText}
      hasDetails={text !== undefined}
      renderContent={text === undefined ? undefined : () => <HistoryTextProjection text={text} />}
    />
  );
}
