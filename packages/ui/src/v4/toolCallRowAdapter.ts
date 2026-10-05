// v4 ToolCallRow → 旧 ToolCallBlocks 输入形态（TaskChatToolCallTreeNode）适配。
// 纯函数：ToolCallBlock 及其 renderers（execute/read/edit/...）吃的是旧 ZCode Agent 的
// TaskChatToolCall 形态；v4 row 自包含，字段一一映射即可，不需要看别的行。
import { buildZCodeStreamingToolInputPreview } from "@zcode/shared";
import { isPlanApprovalToolName } from "@zcode/shared/zcode-protocol-v4";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { normalizeWrappedErrorText } from "@/lib/toolError.js";

// v4 status → 旧 ChatToolCall.status（mapToolStatus 的输入词表：
// pending/in_progress/completed/failed/stopped/denied）。
// permissionDenial 是跨版本兼容的拒绝判别字段；wire status 仍为 cancelled。
// pendingApproval 视为 pending：审批中输入已定，展示为待执行。
const STATUS_MAP: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

interface ResolvedToolInputPreview {
  input: unknown;
  inputPreviewComplete?: boolean;
  streamingRawInputLength?: number;
}

function isEmptyPlainRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** input 缺席时，用 v4 inputText 还原完整或流式半截工具参数预览。 */
function resolveToolInputPreview(row: ToolCallRow): ResolvedToolInputPreview {
  if (row.input !== undefined) {
    return {
      input: row.input,
      inputPreviewComplete: true,
      ...(row.inputText.length > 0 ? { streamingRawInputLength: row.inputText.length } : {}),
    };
  }
  if (!row.inputText) {
    return { input: undefined };
  }
  const preview = buildZCodeStreamingToolInputPreview(row.inputText);
  return {
    input: isEmptyPlainRecord(preview.input) ? undefined : preview.input,
    inputPreviewComplete: preview.complete,
    streamingRawInputLength: row.inputText.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPlanField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 旧拒绝行的兼容判据：落盘缺口（`completedToolPartMetadata` 未写出
 * `permissionDenial`，已补）导致重启前被拒绝的行恢复后退化成普通 `error`
 * 失败——`permissionDenial` 缺席、`error/output` 里是拒绝文案，但 `input`
 * 里的计划完好。判据只认“计划批准工具 + error 态 + input 里有计划内容”，
 * 不认 reason 文案（旧 reason 可能是默认文案也可能是用户反馈，文案易碎）；
 * input 为空的仍是真失败（入参校验失败形），不受兼容影响。
 */
function isLegacyPlanApprovalDenialRow(row: ToolCallRow): boolean {
  if (row.permissionDenial !== undefined) return false;
  if (!isPlanApprovalToolName(row.toolName)) return false;
  if (row.status !== "error") return false;
  const input = isRecord(row.input) ? row.input : undefined;
  if (!input) return false;
  return (
    readPlanField(input["plan"]) !== undefined ||
    readPlanField(input["title"]) !== undefined ||
    readPlanField(input["overview"]) !== undefined
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveV4ToolErrorText(row: ToolCallRow): string | undefined {
  // 计划批准拒绝是预期的搁置终态，不是工具失败：reason 留在 raw.permissionDenial
  // 里可查，但不再以 error 身份进入通用失败语义（徽标/tooltip/失败分支全跟它走）。
  // 豁免只认“计划批准工具 + 拒绝在场”，不用 reason 文案（文案易碎）。
  if (row.permissionDenial) {
    if (isPlanApprovalToolName(row.toolName)) return undefined;
    return row.permissionDenial.reason;
  }
  // 旧拒绝行兼容：落盘缺口导致 `permissionDenial` 缺席、退化成普通 error，
  // 但 input 里计划完好——同样不以 error 身份进入失败语义。判据见
  // isLegacyPlanApprovalDenialRow（工具名 + error 态 + 有计划内容，不认文案）。
  if (isLegacyPlanApprovalDenialRow(row)) return undefined;
  if (row.status !== "error") {
    return undefined;
  }

  const directMessage = readNonEmptyString(row.error?.message);
  if (directMessage) {
    return directMessage;
  }

  const outputText = readNonEmptyString(row.output?.text);
  if (outputText) {
    return normalizeWrappedErrorText(outputText);
  }

  return readNonEmptyString(row.error?.code);
}

export function isPermissionDeniedToolCallRow(row: ToolCallRow): boolean {
  // 计划批准拒绝是预期的搁置终态，不是工具失败：调用方（失败徽标/tooltip、
  // 分组状态、只读时间线）全跟着这个走，豁免收在这里一处，下游零分支。
  // 判据只认“计划批准工具 + 拒绝在场”，不用 reason 文案（文案易碎）。
  return row.permissionDenial !== undefined && !isPlanApprovalToolName(row.toolName);
}

export function toolCallRowToLegacyNode(row: ToolCallRow): TaskChatToolCallTreeNode {
  // 计划批准拒绝的行不判失败，回落非失败终态，渲染层自然走计划卡分支。
  // 新拒绝行走 wire 映射（cancelled→stopped）；旧拒绝行无 wire cancelled 可回落，
  // error→stopped 是唯一的非失败终态映射（failed 会点亮失败语义，denied 同理）。
  // reason 留在 raw 里可查（新行在 raw.permissionDenial，旧行在 raw.error/rawOutput）。
  const legacyDenied = isPermissionDeniedToolCallRow(row);
  const legacyCompat = !legacyDenied && isLegacyPlanApprovalDenialRow(row);
  const legacyStatus = legacyDenied
    ? "denied"
    : legacyCompat
      ? "stopped"
      : STATUS_MAP[row.status];
  const errorText = resolveV4ToolErrorText(row);
  const inputPreview = resolveToolInputPreview(row);
  // CUA 等结构化展示事实位于 output.display；顶层 display 仅是旧 Node REPL 图片通道。
  // 优先读取 canonical output，同时保留旧快照和 Browser 轮尾截图的兼容路径。
  const display = row.output?.display ?? row.display;
  // CUA v1 历史 display 会重复保存 input；工具调用行已经持有唯一输入，桥接时丢弃旧副本。
  const legacyDisplay =
    display?.kind === "cua" ? (({ input: _legacyInput, ...rest }) => rest)(display) : display;
  return {
    toolCall: {
      toolId: row.toolCallId,
      toolName: row.toolName,
      // kind 兼容旧聚合分类：v4 下没有旧 ZCode Agent 快照形态，直接用固定工具名。
      kind: row.toolName,
      input: inputPreview.input,
      status: legacyStatus,
      output: row.output?.text,
      // V4 ToolCallRow 没有 legacy taskNotification raw；background Agent
      // 的终态摘要只落在 output。Agent renderer 读取 content 展示活动结果，因此在
      // Agent/Task 行显式桥接，避免失败详情虽已投影却仍只显示一张空卡。
      ...((row.toolName === "Agent" || row.toolName === "Task") && row.output?.text
        ? { content: row.output.text }
        : {}),
      // v4 row 是自包含投影，部分 provider 只把工具失败正文塞进 output，
      // 不补回 legacy error 会让 ToolOutput 看不到失败原因，只剩一张空的 failed 摘要。
      error: errorText,
      raw: {
        error: row.error,
        rawOutput: row.output?.text,
        outputPreview: row.outputPreview,
        outputTruncated: row.output?.truncated,
        status: legacyStatus,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        v4Status: row.status,
        ...(row.permissionDenial ? { permissionDenial: row.permissionDenial } : {}),
        // 运行时落盘的计划文件路径（ExitPlanMode）：行级事实，不在 input/output 里。
        ...(row.planFilePath ? { planFilePath: row.planFilePath } : {}),
        ...(row.cuaApp ? { cuaApp: row.cuaApp } : {}),
        // 后台任务的 runtime task id（BackgroundTaskStarted 时写入）。TaskOutput 的
        // input.task_id 与它同源，等待期还没拿到工具结果时，靠它关联出 Bash 行上的描述。
        ...(row.workId ? { workId: row.workId } : {}),
        ...(legacyDisplay ? { display: legacyDisplay } : {}),
        inputPreviewComplete: inputPreview.inputPreviewComplete,
        streamingRawInputLength: inputPreview.streamingRawInputLength,
      },
      startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
      // 终态定格耗时（毫秒）。从未执行的行没有这个字段，界面据此不显示耗时。
      durationMs: typeof row.durationMs === "number" ? row.durationMs : undefined,
    },
    // subagent 不内嵌 child rows；v4 工具行没有子树，嵌套工具在旧形态里也
    // 由独立 row（subagent/toolCall）表达。
    childToolCalls: [],
  };
}
