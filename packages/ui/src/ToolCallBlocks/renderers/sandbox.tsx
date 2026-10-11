import { Box } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import {
  readSandboxOutputProjection,
  stripSystemReminderBlocks,
} from "@/ToolCallBlocks/toolTextProjection.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import type { ToolCallSandboxDisplay } from "@zcode/shared/zcode-protocol-v4";

// ============================================================
// Sandbox 工具（会话级 QuickJS 隔离计算面）的聊天卡
// ============================================================
// 折叠行只显示模型传入的一句话说明（input.description），源码和输出在展开态。
// display 载荷只带状态与后台 ID（status/backgroundTaskId），说明文本不经载荷转手
// （Bash 卡 getExecuteDescription 同款惯例）。后台态显示“已在后台”（带 task ID）。
// 图标刻意不用终端形：Sandbox 不是 shell family（见 tool-identity 注释与 spec）。
// 规则见 docs/specs/sandbox-system-tool.md「聊天工具卡」。

const SANDBOX_TOOL_ICON = <Box className="size-4 shrink-0 text-foreground-subtle" />;

/** 摘要拼装只依赖 formatMessage 的最小面，方便纯函数单测。 */
export type SandboxSummaryFormat = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 折叠行说明预览上限：一句话说明是主角但不能无限撑宽。 */
const DESCRIPTION_PREVIEW_MAX_CHARS = 60;

export function formatSandboxDescriptionPreview(description: string): string {
  const trimmed = description.trim();
  const chars = Array.from(trimmed);
  return chars.length > DESCRIPTION_PREVIEW_MAX_CHARS
    ? `${chars.slice(0, DESCRIPTION_PREVIEW_MAX_CHARS).join("")}…`
    : trimmed;
}

/** 从 toolCall.input 读必填说明（折叠行唯一主体；display 缺席时同一字段兜底）。 */
export function readSandboxDescriptionFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const candidate = (input as Record<string, unknown>).description;
  if (typeof candidate !== "string" || candidate.trim().length === 0) return undefined;
  return candidate;
}

/** 从 toolCall.input 读内联源码或文件路径（展开态只读展示，不进折叠行）。 */
export function readSandboxSourceFromInput(input: unknown): { code?: string; filePath?: string } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const code =
    typeof record.code === "string" && record.code.trim().length > 0 ? record.code : undefined;
  const filePath =
    typeof record.filePath === "string" && record.filePath.trim().length > 0
      ? record.filePath.trim()
      : undefined;
  if (code === undefined && filePath === undefined) return undefined;
  return { ...(code !== undefined ? { code } : {}), ...(filePath !== undefined ? { filePath } : {}) };
}

export function sandboxSummaryText(
  display: ToolCallSandboxDisplay | undefined,
  description: string | undefined,
  format: SandboxSummaryFormat,
): string | undefined {
  // 后台态：显示“已在后台”（带 task ID），不把代码当摘要。
  if (display?.status === "backgrounded") {
    return display.backgroundTaskId
      ? format(
          { id: "chat.toolCall.sandbox.backgroundedWithId" },
          { taskId: display.backgroundTaskId },
        )
      : format({ id: "chat.toolCall.sandbox.backgrounded" });
  }
  if (description === undefined) return undefined;
  return formatSandboxDescriptionPreview(description);
}

/**
 * 展开态文本：v4 wire 的 output.text 是 formatModelContent 投影（模型读到的同一段）。
 * 与 history.tsx 的 readTextProjection 同口径；渲染前必须剥模型信封
 * （见 toolTextProjection：`<system-reminder>` 直接丢，`<return>`/`<console>`
 * 只留正文）。用户侧完全不显示新实例提示。
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
    if (
      isPlainRecord(candidate) &&
      typeof candidate.text === "string" &&
      candidate.text.trim().length > 0
    ) {
      return candidate.text;
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function SandboxTextProjection({ text }: { text: string }) {
  const projection = readSandboxOutputProjection(text);
  // 合卡：return 与 console 正文进同一个代码块（return 在上、console 在下，空一行分隔）；
  // 只有一个时只显示那个。用户侧不再看到两个拆开的块。
  const combined = [projection.returnText, projection.consoleText]
    .filter((part) => part !== undefined && part.trim().length > 0)
    .join("\n\n");
  if (combined.trim().length === 0) return null;
  return (
    <pre className="mb-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 font-mono text-ui-base text-foreground">
      {combined}
    </pre>
  );
}

function SandboxSourceProjection({ code, filePath }: { code?: string; filePath?: string }) {
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-panel">
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-ui-base text-foreground">
        {filePath !== undefined ? `路径：${filePath}\n` : ""}
        {code ?? ""}
      </pre>
    </div>
  );
}

/** Sandbox：折叠行 = 一句话说明（后台态为“已在后台+ID”）；展开 = 源码 + 输出文本投影。 */
export function SandboxToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const sandboxDisplay = display?.kind === "sandbox" ? display : undefined;
  const text = useMemo(() => readTextProjection(toolCall), [toolCall]);
  const source = useMemo(() => readSandboxSourceFromInput(toolCall.input), [toolCall.input]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning ? "chat.toolCall.sandbox.running" : "chat.toolCall.sandbox.ran",
  });
  const inputDescription = useMemo(
    () => readSandboxDescriptionFromInput(toolCall.input),
    [toolCall.input],
  );
  const summary = useMemo(
    () => sandboxSummaryText(sandboxDisplay, inputDescription, intl.formatMessage),
    [intl, inputDescription, sandboxDisplay],
  );
  const primaryText = useMemo(
    () => <span className="truncate text-foreground-subtlest">{summary}</span>,
    [summary],
  );
  const hasExpandableContent = text !== undefined || source !== undefined;
  // 失败态 tooltip 剥 reminder：错误文本里可能拼了给模型的新实例提示（用户侧不显示）。
  const failureTooltip = useMemo(
    () =>
      toolCall.status === "failed" && context.errorText !== undefined
        ? stripSystemReminderBlocks(context.errorText)
        : context.errorText,
    [context.errorText, toolCall.status],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SANDBOX_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={(hasExpandableContent || summary !== undefined) && (context.canToggle ?? true)}
        forceOpen={(hasExpandableContent || summary !== undefined) && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={toolCall.status === "failed" ? context.statusLabel : undefined}
        statusTooltip={toolCall.status === "failed" ? failureTooltip : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={
          !hasExpandableContent
            ? undefined
            : () => (
                <>
                  {source !== undefined ? (
                    <SandboxSourceProjection code={source.code} filePath={source.filePath} />
                  ) : null}
                  {text !== undefined ? <SandboxTextProjection text={text} /> : null}
                </>
              )
        }
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
