import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import {
  extractZCodeSessionCitationLinks,
  projectLegacyZCodeSessionCitationDirectives,
} from "@/lib/zcodeSessionCitation.js";

/**
 * AI 搜索来源行：模型正文 ycode 会话链接 + 存在性校验后的引用。
 * 与旧 display citations 同形（sessionId/title/segment/snippet/at），
 * 来源行渲染与跳转逻辑无需改动（segment 恒为 1，仅作 key 用）。
 */
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
  /**
   * 来源列表：从最后一条完成态正文的会话引用指令抽取，经存在性校验后
   * 按会话去重（首命中保留）。不在集合里的引用（模型编造）不进列表。
   */
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
 * 归纳正文（最后一条完成态 assistantText）+ 来源（正文会话引用指令抽取）。
 * 纯函数，便于单测；组件内用 useMemo 包一层。
 * 不读 userInput 行（首条是 prompt 指令，不是答案）。
 * 工具摘要的文案拼装（kindLabel/summary）由组件用聊天卡同实现完成，
 * 这里只输出结构化事实（toolName/running/display/inputQuery）。
 *
 * 来源改源说明（docs/specs/assistant-session-citation.md）：
 * 旧来源是 HistorySearch display.citations（工具算的），新来源是模型正文里的
 * 会话引用指令（模型写的），经存在性集合校验（真实存在的会话才进列表）。
 * 抽取只解析最后一条完成态正文，不扫投影窗口；集合由调用方同步传入
 * （命令中心按 sessions-index + 任务行构建），本函数不碰 store、不做异步查询。
 */
export function selectAiSearchAnswerContent(
  state: ConversationStoreState | null | undefined,
  options: { existingSessionIds?: ReadonlySet<string> } = {},
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
    }
  }
  // 来源：从最终答案正文抽会话引用指令，经存在性校验后按会话去重。
  // 遗留 `:::zcode-session-citation{...}` 指令块不进来源（不恢复兼容），且答案正文
  // 与顶部预览在返回前先剥离成纯文本，永不把指令原文带给用户。
  const citations = extractCitationsFromAnswer(finalText, options.existingSessionIds);
  const answerText = projectLegacyZCodeSessionCitationDirectives(finalText, { streaming: false });
  const previewLine = firstContentLine(
    projectLegacyZCodeSessionCitationDirectives(latestText, { streaming }),
  );
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
    answerText,
    previewLine,
    activeTool,
    streaming,
    completed,
    turnFailed,
    turnError,
    citations,
  };
}

/**
 * 从最终答案正文抽 ycode 会话链接：只解析这一条文本 + 存在性 O(1) 判断，
 * 不扫投影窗口。集合外的 session（模型编造/不存在）直接丢掉。
 * 集合缺席（索引未就绪）= 不校验，全部保留（与正文渲染同一 fail-open 纪律）。
 */
function extractCitationsFromAnswer(
  answerText: string,
  existingSessionIds?: ReadonlySet<string>,
): AiSearchCitation[] {
  if (!answerText) return [];
  const links = extractZCodeSessionCitationLinks(answerText);
  if (links.length === 0) return [];
  const out: AiSearchCitation[] = [];
  const seenSessions = new Set<string>();
  for (const link of links) {
    const sessionId = link.session.trim();
    if (!sessionId || seenSessions.has(sessionId)) continue;
    // 存在性校验：不在集合里的 session 不进来源。
    if (existingSessionIds && !existingSessionIds.has(sessionId)) continue;
    seenSessions.add(sessionId);
    // search 缺席无法定位：来源列表丢弃（正文仍可渲染芯片）。
    const snippet = link.search?.trim() ?? "";
    if (!snippet) continue;
    out.push({
      sessionId,
      title: link.text.trim() || null,
      segment: 1,
      snippet,
      // 正文链接不带时间：来源行时间徽标缺席（at=null 即不渲染）。
      at: null,
    });
  }
  return out;
}

/** 顶部第一行：正文空白折叠后的全文单行版；单行省略由样式（truncate）完成。 */
function firstContentLine(answerText: string): string {
  return answerText.replace(/\s+/g, " ").trim();
}

/**
 * 跳转高亮用的纯文本：display 摘录带【】关键词标记与…省略号，
 * 定位时去掉标记，还原可匹配的连续文本。
 * 正文指令的 text 同样可能带标记，同一函数清洗。
 */
export function citationJumpText(snippet: string): string {
  return snippet
    .replace(/[【】]/g, "")
    .replace(/^[…\s]+/, "")
    .replace(/[…\s]+$/, "")
    .trim();
}
