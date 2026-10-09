import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";

/** AI 搜索来源行：一次 History 命中的会话 + 段坐标 + 摘录（display 结构化引用）。 */
export interface AiSearchCitation {
  sessionId: string;
  title: string | null;
  segment: number;
  snippet: string;
  /** 命中消息时间（unix ms）；缺失时为 null，来源行的时间徽标据此渲染。 */
  at: number | null;
}

/** 顶部第二行的工具调用：复用正常聊天工具行的折叠行摘要实现。 */
export interface AiSearchActiveTool {
  toolName: string;
  running: boolean;
  /** display 载荷（History 三工具才有），组件用聊天卡同实现拼 kindLabel/summary。 */
  display: unknown;
  /** 工具输入（query 的输入兜底用），display 缺席时退回输入侧纯关键词。 */
  input: unknown;
}

export interface AiSearchAnswerContent {
  /**
   * 归纳正文：最后一条完成态 assistantText（最终答案）。
   * 中间过程的多条正文不拼进来——打开历史会话也只看最后一条完成消息。
   * 运行中（无完成消息）时为空；组件只在完成后展示全文入口。
   */
  answerText: string;
  /** 顶部第一行：最新一条正文（含流式中）的单行预览；无正文时为空。 */
  previewLine: string;
  /** 顶部第二行：最后一次工具调用；无工具调用时为 null。 */
  activeTool: AiSearchActiveTool | null;
  /** 模型仍在写（有 streaming 行）。 */
  streaming: boolean;
  /**
   * 回合是否收口成功（snapshot.control.sessionEnded）。
   * 全文入口与来源列表只在完成后展示——运行中不存在「最后一条」的概念。
   */
  completed: boolean;
  /** 回合是否失败（control.phase === "error"）。 */
  turnFailed: boolean;
  /** 回合失败时的服务端文案（control.lastError.message）；无则为 null。 */
  turnError: string | null;
  /** 来源列表：HistorySearch display citations 按会话去重（首命中保留）。 */
  citations: AiSearchCitation[];
}

const EMPTY_CONTENT: AiSearchAnswerContent = {
  answerText: "",
  previewLine: "",
  activeTool: null,
  streaming: false,
  completed: false,
  turnFailed: false,
  turnError: null,
  citations: [],
};

function readCitations(display: unknown): AiSearchCitation[] {
  if (!display || typeof display !== "object") return [];
  const record = display as Record<string, unknown>;
  if (record.kind !== "history_search" || !Array.isArray(record.citations)) return [];
  const out: AiSearchCitation[] = [];
  for (const item of record.citations) {
    if (!item || typeof item !== "object") continue;
    const hit = item as Record<string, unknown>;
    if (typeof hit.sessionId !== "string" || hit.sessionId.length === 0) continue;
    if (typeof hit.segment !== "number" || !Number.isInteger(hit.segment) || hit.segment < 1) {
      continue;
    }
    if (typeof hit.snippet !== "string" || hit.snippet.length === 0) continue;
    out.push({
      sessionId: hit.sessionId,
      title: typeof hit.title === "string" ? hit.title : null,
      segment: hit.segment,
      snippet: hit.snippet,
      at: typeof hit.at === "number" ? hit.at : null,
    });
  }
  return out;
}

function readTurnError(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const control = (snapshot as Record<string, unknown>).control;
  if (!control || typeof control !== "object") return null;
  const lastError = (control as Record<string, unknown>).lastError;
  if (!lastError || typeof lastError !== "object") return null;
  const message = (lastError as Record<string, unknown>).message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

/**
 * 从隐藏会话投影读回答区内容：顶部两行过程（最新正文预览 + 最后工具调用）、
 * 归纳正文（最后一条完成态 assistantText）+ 来源（HistorySearch display citations）。
 * 纯函数，便于单测；组件内用 useMemo 包一层。
 * 不读 userInput 行（首条是 prompt 指令，不是答案）。
 * 工具摘要的文案拼装（kindLabel/summary）由组件用聊天卡同实现完成，
 * 这里只输出结构化事实（toolName/running/display/inputQuery）。
 */
export function selectAiSearchAnswerContent(
  state: ConversationStoreState | null | undefined,
): AiSearchAnswerContent {
  const snapshot = state?.snapshot;
  const completed = snapshot?.control.sessionEnded === true;
  const turnFailed = snapshot?.control.phase === "error";
  const turnError = readTurnError(snapshot);
  const rows = snapshot?.rows?.window;
  if (!rows || rows.length === 0) {
    if (!completed && !turnFailed) return EMPTY_CONTENT;
    return { ...EMPTY_CONTENT, completed, turnFailed, turnError };
  }

  // 最新一条正文（含流式中）进顶部预览；最后一条完成态正文才是最终答案。
  let latestText = "";
  let finalText = "";
  let streaming = false;
  let activeTool: AiSearchActiveTool | null = null;
  const citations: AiSearchCitation[] = [];
  const seenSessions = new Set<string>();
  for (const row of rows) {
    if (row.kind === "assistantText") {
      if (row.text) latestText = row.text;
      if (row.state === "complete" && row.text) finalText = row.text;
      if (row.state === "streaming") streaming = true;
    } else if (row.kind === "toolCall") {
      // 第二行永远是最后一次工具调用（含运行中与终态）。
      activeTool = {
        toolName: row.toolName,
        running: row.status === "inputStreaming" || row.status === "running",
        display: row.output?.display ?? null,
        input: row.input ?? null,
      };
      if (row.toolName !== "HistorySearch") continue;
      // 只收 success 行的引用；error/cancelled 行无 display。
      if (row.status !== "success" || !row.output) continue;
      for (const citation of readCitations(row.output.display)) {
        if (seenSessions.has(citation.sessionId)) continue;
        seenSessions.add(citation.sessionId);
        citations.push(citation);
      }
    }
  }
  if (
    latestText.length === 0 &&
    citations.length === 0 &&
    !streaming &&
    !activeTool &&
    !completed &&
    !turnFailed
  ) {
    return EMPTY_CONTENT;
  }
  return {
    answerText: finalText,
    previewLine: firstContentLine(latestText),
    activeTool,
    streaming,
    completed,
    turnFailed,
    turnError,
    citations,
  };
}

/** 顶部第一行：正文空白折叠后的全文单行版；单行省略由样式（truncate）完成。 */
function firstContentLine(answerText: string): string {
  return answerText.replace(/\s+/g, " ").trim();
}

/**
 * 跳转高亮用的纯文本：display 摘录带【】关键词标记与…省略号，
 * 定位时去掉标记，还原可匹配的连续文本。
 */
export function citationJumpText(snippet: string): string {
  return snippet
    .replace(/[【】]/g, "")
    .replace(/^[…\s]+/, "")
    .replace(/[…\s]+$/, "")
    .trim();
}
