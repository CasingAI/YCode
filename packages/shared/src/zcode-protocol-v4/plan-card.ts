// 计划卡「有效且默认展示」的跨端纯判据。
//
// 正文（UI 脱流）与侧栏摘要（CLI sessions-index）必须对同一行给同一个答案：
// 工具身份是计划工具、内容能撑起折叠卡、且不是真失败。两侧各写一套，迟早漂移成
// 「正文看得见计划卡、侧栏却认为没有」或反之。本包纪律：只放纯函数，不依赖 UI。
import type { ConversationRow } from "./rows.js";
import { isPlanApprovalToolName } from "./plan-approval.js";
import { buildZCodeStreamingToolInputPreview } from "../streaming-tool-input-preview.js";

/** 计划卡成形所需的展示字段；`planFilePath` 不参与「能不能成卡」。 */
export interface PlanCardContent {
  markdown?: string;
  title?: string;
  overview?: string;
}

export interface PlanCardToolCallLike {
  toolName: string;
  status?: string;
  permissionDenial?: unknown;
  input?: unknown;
  inputText?: string;
  output?: { text?: string } | undefined;
  error?: { code?: string; message?: string } | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = readNonEmptyString(value[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function extractPlanContent(source: unknown): PlanCardContent {
  if (typeof source === "string" && source.trim().length > 0) {
    return { markdown: source.trim() };
  }
  if (!isRecord(source)) return {};
  const markdown = readStringField(source, ["plan", "text", "content"]);
  const title = readStringField(source, ["title"]);
  const overview = readStringField(source, ["overview"]);
  return {
    ...(markdown ? { markdown } : {}),
    ...(title ? { title } : {}),
    ...(overview ? { overview } : {}),
  };
}

/**
 * 这条计划行是否带得动一张折叠卡：正文、标题、概述任一在场即可。
 *
 * 与渲染器的 `shouldRenderCollapsedPlanCard` 同源：流式早期 title/overview 已到、
 * 正文还没流完时，卡片已经成立。缺省只认这三个字段，`planFilePath` 不算内容。
 */
export function hasPlanCardContent(content: PlanCardContent): boolean {
  return (
    content.markdown !== undefined || content.title !== undefined || content.overview !== undefined
  );
}

/**
 * 按渲染同款优先级取计划内容：结构化 input → 流式 inputText 预览。
 *
 * v4 `ToolCallRow.output` 只有 `{ text, display?, truncated? }`，`text` 是工具执行结果
 * （确认文案、报错或任意旧计划字符串），不是计划正文；结构化 plan/title/overview
 * 输出在 v4 schema 下不可达，因此这里不读 output。历史 legacy 节点的 output/rawOutput
 * 兼容由 UI 的 legacy 提取路径负责，shared 不构建 v4 不会产生的形状。
 */
export function extractPlanCardContent(row: PlanCardToolCallLike): PlanCardContent {
  const inputContent = extractPlanContent(row.input);
  if (hasPlanCardContent(inputContent)) return inputContent;

  if (row.inputText?.trim()) {
    // 流式 inputText 可能不是完整 JSON；预览层按字段名回收半截 title/overview/plan，
    // 与 UI 适配层 `toolCallRowToLegacyNode` 的输入预览走同一实现。
    const preview = buildZCodeStreamingToolInputPreview(row.inputText);
    const content = extractPlanContent(preview.input);
    if (hasPlanCardContent(content)) return content;
  }

  return {};
}

/**
 * 系统侧入参/出参校验失败的判据：这类行从未走到权限门，不是被用户拒绝的计划。
 *
 * 框架生成的固定签名（不是用户反馈文案）：
 * - live 行：`error.code === "tool_execution_failed"`；
 * - 冷恢复行：code 被改写成 `"fault.runtime.toolFailed"`，只能靠 message/output 里的
 *   固定字面量识别。真旧拒绝行的 code 同样是 `fault.runtime.toolFailed`，所以 code
 *   不能单独作为判据，必须看签名。
 */
export function isSystemToolValidationFailure(row: PlanCardToolCallLike): boolean {
  if (row.error?.code === "tool_execution_failed") return true;
  const texts = [row.error?.message, row.output?.text];
  for (const text of texts) {
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const lower = text.toLowerCase();
    if (lower.includes("inputschema validation")) return true;
    if (lower.includes("outputschema validation")) return true;
    if (text.includes("InputValidationError")) return true;
  }
  return false;
}

// 历史拒绝兼容只属于旧 `ExitPlanMode`：它是审批门工具，落盘缺口会让被用户拒绝的行
// 恢复成普通 error。现役 `CreatePlan` 无审批门，它的 error 是真实执行/校验失败，
// 不能因为入参里带着计划正文就被当成「用户拒绝、计划仍有效」。
function isLegacyExitPlanModeToolName(toolName: string): boolean {
  return toolName.trim().toLowerCase() === "exitplanmode";
}

/**
 * 旧拒绝行的兼容判据：落盘缺口导致重启前被拒绝的行恢复后退化成普通 `error` 失败，
 * `permissionDenial` 缺席、`error/output` 里是拒绝文案，但 `input` 里的计划完好。
 * 只认「旧 ExitPlanMode + error 态 + input 里有计划内容」，不认 reason 文案；input
 * 为空的仍是真失败。系统级校验失败先排除。
 */
export function isLegacyPlanApprovalDenialRow(row: PlanCardToolCallLike): boolean {
  if (row.permissionDenial !== undefined) return false;
  if (!isLegacyExitPlanModeToolName(row.toolName)) return false;
  if (row.status !== "error") return false;
  if (isSystemToolValidationFailure(row)) return false;
  const input = isRecord(row.input) ? row.input : undefined;
  if (!input) return false;
  return (
    readNonEmptyString(input["plan"]) !== undefined ||
    readNonEmptyString(input["title"]) !== undefined ||
    readNonEmptyString(input["overview"]) !== undefined
  );
}

function isFailedPlanCardRow(row: PlanCardToolCallLike): boolean {
  // 计划批准拒绝是预期的搁置终态，不是工具失败；历史拒绝行也按同一语义豁免。
  if (row.permissionDenial !== undefined) return false;
  if (isLegacyPlanApprovalDenialRow(row)) return false;
  if (row.status === "error") return true;
  return typeof row.error?.message === "string" && row.error.message.trim().length > 0;
}

/**
 * 这一行渲染出来是不是一张默认展示的有效计划卡。
 *
 * 三条同时成立：计划工具身份、不是真失败、内容能成卡。历史 `ExitPlanMode` 与现役
 * `CreatePlan` 都走 `isPlanApprovalToolName`；流式半成卡（title/overview 已到）算有效。
 */
export function isPlanCardToolCallRow(row: PlanCardToolCallLike): boolean {
  if (!isPlanApprovalToolName(row.toolName)) return false;
  if (isFailedPlanCardRow(row)) return false;
  return hasPlanCardContent(extractPlanCardContent(row));
}

export interface AssistantResponseAnchorOptions {
  /** 已从正文 flow 拆出的轮尾行：不参与锚点判定。 */
  ignoredRowIds?: ReadonlySet<number>;
}

/**
 * 这一段里最后一次 assistant response 的身份。
 *
 * 一次模型请求产出一条助手响应，这次响应产出的正文 / 思考 / 工具行共享同一个
 * `assistantResponseId`。取最后一条助手工作行携带的 id 当锚点；缺 id 就返回
 * undefined（证不出归属，失败向安全侧倒），不得拿更早行的 id 冒充最后一次。
 *
 * 只看身份，不看 UI 可见性：空 `text_start` / 空 reasoning 占位、`EnterPlanMode` 等
 * 不渲染或不成卡的行，只要携带 id 就是「新响应已开始」的证据。UI 的可见行过滤与
 * 这里的锚点判定是两件事；若这里先按渲染过滤，正文会把空占位当没发生，而侧栏会
 * 把后续响应认成同一响应，重新出现「正文已无卡、侧栏仍描边」的假象。subagent /
 * timelineMarker 等本身不带 `assistantResponseId` 的行不参与。
 */
export function resolveLastAssistantResponseId(
  rows: readonly ConversationRow[],
  options: AssistantResponseAnchorOptions = {},
): string | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || options.ignoredRowIds?.has(row.rowId)) continue;
    if (row.kind !== "assistantText" && row.kind !== "reasoning" && row.kind !== "toolCall") {
      continue;
    }
    return row.assistantResponseId;
  }
  return undefined;
}

/**
 * 最后一个 product turn 的最后一次 assistant response 里有没有默认展示的有效计划卡。
 *
 * 只倒扫最后一个 `turnHeader` 之后的区间；没有轮头（裁剪窗口 / 冷恢复缺轮边界）判否。
 * 计划行必须与最后一次响应的 `assistantResponseId` 相同——早期响应里的计划卡、被后续
 * reasoning / tool / text 响应接续的计划卡都不算；缺 id 一律判否。用户批准、磁盘计划
 * 文件、Plan 模式本身都不参与判定。
 */
export function hasPlanCardInLastAssistantResponse(rows: readonly ConversationRow[]): boolean {
  let lastTurnStart = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.kind === "turnHeader") {
      lastTurnStart = i;
      break;
    }
  }
  if (lastTurnStart < 0) return false;
  const turnRows = rows.slice(lastTurnStart + 1);
  const responseId = resolveLastAssistantResponseId(turnRows);
  if (responseId === undefined) return false;
  for (const row of turnRows) {
    if (row.kind !== "toolCall") continue;
    if (row.assistantResponseId !== responseId) continue;
    if (isPlanCardToolCallRow(row)) return true;
  }
  return false;
}
