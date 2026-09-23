import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";

interface PlanToolCallSource {
  input?: unknown;
  inputText?: string;
  output?: unknown;
  /**
   * 行级路径：运行时在计划文件落盘后补齐的工具行字段（v4 `ToolCallRow.planFilePath`）。
   * 旧形态节点由 toolCallRowAdapter 放进 `raw.planFilePath`。
   */
  planFilePath?: unknown;
  raw?: unknown;
}

interface PlanToolCallContent {
  markdown?: string;
  planFilePath?: string;
  /** ExitPlanMode 输入的折叠卡标题；缺省时由调用方回退 getPlanDirectoryTitle 提取。 */
  title?: string;
  /** ExitPlanMode 输入的折叠卡概述；无法从正文推导，缺省时卡片走历史全文预览渲染。 */
  overview?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function resolvePlanFilePath(path: string | undefined, workspacePath: string) {
  if (!path) return undefined;
  return isAbsoluteFilePath(path) ? path : joinFilePath(workspacePath, path);
}

function extractPlanMarkdown(source: unknown, workspacePath: string): PlanToolCallContent {
  if (typeof source === "string" && source.trim().length > 0) {
    return { markdown: source.trim() };
  }
  if (!isRecord(source)) return {};

  const markdown = readStringField(source, ["plan", "text", "content"]);
  const planFilePath = resolvePlanFilePath(
    readStringField(source, ["planFilePath"]),
    workspacePath,
  );
  if (!markdown) return {};
  const title = readStringField(source, ["title"]);
  const overview = readStringField(source, ["overview"]);
  return {
    markdown,
    ...(planFilePath ? { planFilePath } : {}),
    ...(title ? { title } : {}),
    ...(overview ? { overview } : {}),
  };
}

export function extractPlanToolCallContent(
  toolCall: PlanToolCallSource,
  workspacePath: string,
): PlanToolCallContent {
  return withRowPlanFilePath(
    extractPlanContentFromToolCall(toolCall, workspacePath),
    toolCall,
    workspacePath,
  );
}

/**
 * 行级路径是**独立于正文来源**的事实：正文来自模型入参，路径只有运行时知道（落盘后经
 * `plan_file_written` 事件补齐到工具行），所以既不在 input 也不在 output 里。
 * 优先级链一律不动，这里只补一个所有来源都没有的字段；已有值不覆盖，
 * 历史行（服务器没有下发路径）保持原样、卡片与面板逐项降级。
 */
function withRowPlanFilePath(
  content: PlanToolCallContent,
  toolCall: PlanToolCallSource,
  workspacePath: string,
): PlanToolCallContent {
  if (!content.markdown || content.planFilePath) return content;
  const planFilePath = resolvePlanFilePath(readRowPlanFilePath(toolCall), workspacePath);
  return planFilePath ? { ...content, planFilePath } : content;
}

function readRowPlanFilePath(toolCall: PlanToolCallSource): string | undefined {
  if (typeof toolCall.planFilePath === "string" && toolCall.planFilePath.trim()) {
    return toolCall.planFilePath.trim();
  }
  return isRecord(toolCall.raw) ? readStringField(toolCall.raw, ["planFilePath"]) : undefined;
}

function extractPlanContentFromToolCall(
  toolCall: PlanToolCallSource,
  workspacePath: string,
): PlanToolCallContent {
  const inputContent = extractPlanMarkdown(toolCall.input, workspacePath);
  if (inputContent.markdown) return inputContent;

  if (toolCall.inputText?.trim()) {
    try {
      const content = extractPlanMarkdown(JSON.parse(toolCall.inputText), workspacePath);
      if (content.markdown) return content;
    } catch {
      // 流式 inputText 可能暂时不是完整 JSON；继续走 legacy raw fallback。
    }
  }

  const outputContent = extractPlanMarkdown(toolCall.output, workspacePath);
  if (outputContent.markdown) return outputContent;

  if (!isRecord(toolCall.raw)) return {};
  for (const candidate of [toolCall.raw.rawInput, toolCall.raw.rawOutput]) {
    const content = extractPlanMarkdown(candidate, workspacePath);
    if (content.markdown) return content;
  }

  const rawContent = Array.isArray(toolCall.raw.content) ? toolCall.raw.content : [];
  for (const entry of rawContent) {
    if (!isRecord(entry)) continue;
    const nested = isRecord(entry.content) ? entry.content : entry;
    const content = extractPlanMarkdown(nested, workspacePath);
    if (content.markdown) return content;
  }
  return {};
}

/**
 * 工具调用是否还在流式。
 *
 * v4 row 在 input 定稿前只逐 delta 累加 `inputText`、status 停在 `inputStreaming`，解析后的
 * `input` 要等定稿那次 upsert 才补上；旧形态节点由 toolCallRowAdapter 把这两件事分别放在
 * `raw.v4Status` 与 `raw.inputPreviewComplete` 上。
 */
export function isPlanToolCallInputStreaming(toolCall: PlanToolCallSource): boolean {
  if (!isRecord(toolCall.raw)) return false;
  if (toolCall.raw.v4Status === "inputStreaming") return true;
  return toolCall.raw.inputPreviewComplete === false;
}

/**
 * 计划卡是否该渲染折叠形态：有正文，且不是「定稿的旧调用」。
 *
 * 判据必须是调用状态而不是「`overview` 有没有值」——`overview` 是 ExitPlanMode 的 schema
 * 必填，定稿后必然存在，缺席只有两种含义：还在流式（`input` 未解析），或这份计划来自
 * `overview` 之前的版本。按字段有无判断会把这两者混为一谈，而模型先写完整篇 `plan` 才写
 * `overview`，于是整段输出期都显示旧的全文预览、定稿瞬间翻牌。
 */
export function shouldRenderCollapsedPlanCard(input: {
  hasMarkdown: boolean;
  overview?: string;
  streaming: boolean;
}): boolean {
  if (!input.hasMarkdown) return false;
  return input.streaming || input.overview !== undefined;
}

const MARKDOWN_H1_PATTERN = /^\s{0,3}#(?!#)\s+(.+?)\s*#*\s*$/m;
const MARKDOWN_LEADING_DECORATION = /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/;

/** 计划目录标题取首个 H1，否则取首个非空文本行。 */
export function getPlanDirectoryTitle(markdown: string): string | undefined {
  const h1 = MARKDOWN_H1_PATTERN.exec(markdown)?.[1]?.trim();
  if (h1) return h1;
  for (const line of markdown.split(/\r?\n/u)) {
    const title = line.replace(MARKDOWN_LEADING_DECORATION, "").trim();
    if (title) return title;
  }
  return undefined;
}

/**
 * 计划详情面板路径行的显示值：计划文件在 workspace 下时给相对路径（`.zcode/plans/…`），
 * 否则原样返回——路径可能来自别的 workspace 或根本不是这个 workspace 的文件，
 * 硬按前缀截断只会给出一个不存在的相对路径。
 */
export function getPlanPathLabel(planFilePath: string, workspacePath?: string): string {
  if (!workspacePath) return planFilePath;
  const normalizedBase = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = planFilePath.replace(/\\/g, "/");
  if (!normalizedBase || !normalizedPath.startsWith(`${normalizedBase}/`)) return planFilePath;
  return normalizedPath.slice(normalizedBase.length + 1) || planFilePath;
}

/**
 * 详情面板头部已经渲染了标题，正文再把同一个 H1 渲染一遍就是重复。
 *
 * 只删**首个非空行**且与标题完全相同的 H1——标题常常正是从它提取来的（`getPlanDirectoryTitle`
 * 优先取 H1）。不同名的 H1 保留：那是正文自己的结构，不是重复。其余正文逐字不动。
 */
export function stripLeadingPlanTitleHeading(markdown: string, title?: string): string {
  const normalizedTitle = title?.trim();
  if (!normalizedTitle) return markdown;
  const lines = markdown.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
  const leadingHeading = MARKDOWN_H1_PATTERN.exec(lines[index] ?? "")?.[1]?.trim();
  if (leadingHeading !== normalizedTitle) return markdown;
  return [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n");
}
