import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
  overlapsAssistantTextRanges,
} from "@/lib/assistantDirectiveParser.js";

// 模型在正文里直接输出 Markdown 会话引用链接（docs/specs/assistant-session-citation.md）：
// `[原文片段](ycode://session/open?sessionId=<id>&search=<原文片段>)`，UI 渲染成可点芯片。
// `:::zcode-session-citation{...}` 指令块已彻底删除：不解析成引用、不投影、不转换、不兜底；
// 老内容里的遗留指令块在渲染与导出中一律剥离成纯文本（见 stripLegacyZCodeSessionCitationDirectives），
// 永不向用户显示原文。旧 `zcode-session:` 链接形态同样清除，只认 ycode。
export interface ZCodeSessionCitationLink {
  end: number;
  raw: string;
  /** 目标会话 id（必填）。 */
  session: string;
  /** 打开后自动定位的查询串（search/text 同源，跳转后用于搜索高亮）。 */
  search?: string;
  start: number;
  /** 链接文本（定位用的原文片段，与 search 同源）。 */
  text: string;
}

interface ZCodeSessionCitationProjection {
  visibleText: string;
  /**
   * 流式占位：streaming 且尾部有「已识别到 sessionId 但尚未闭合」的 ycode 引用链接时，
   * visibleText 末尾已补一枚 pending 链接（`ycode://session/pending?…`），
   * 由 message.tsx 的 `a` 渲染器画成固定最小宽度占位芯片。这里回传 session
   * 供单测断言结构；渲染层不需要读它（占位已在 visibleText 里）。
   */
  pendingSessionId?: string;
}

/** ycode 系统协议：scheme 固定 ycode，与 zcode 并存，不替换现有深链。 */
export const ZCODE_SESSION_CITATION_YCODE_SCHEME = "ycode:";
/** ycode 会话引用 host：固定字面量，session id 放 query（host 受 URL 规范化约束）。 */
export const ZCODE_SESSION_CITATION_YCODE_HOST = "session";
/** ycode 会话引用动作 path：跟 zcode://workspace/open 同约定（host 为域、path 为动作）。 */
export const ZCODE_SESSION_CITATION_YCODE_ACTION_PATH = "/open";
/** ycode 会话引用 pending 占位动作 path：流式未闭合时预解析补的占位链接专用。 */
export const ZCODE_SESSION_CITATION_YCODE_PENDING_ACTION_PATH = "/pending";

/**
 * 遗留指令块名称：只做剥离用，不恢复任何引用语义（docs/specs/assistant-session-citation.md
 * 「遗留指令语法一律剥离」）。历史消息、旧分享、旧索引里仍可能躺着这种文本。
 */
export const LEGACY_ZCODE_SESSION_CITATION_DIRECTIVE_NAME = "zcode-session-citation";
const LEGACY_ZCODE_SESSION_CITATION_SYNTAX = {
  allowSingleColon: true,
  allowSmartQuotes: true,
  allowTripleColon: true,
} as const;
const LEGACY_ZCODE_SESSION_CITATION_SINGLE_COLON_PREFIX_LENGTH = ":zcode".length;

export interface LegacyZCodeSessionCitationDirective {
  end: number;
  raw: string;
  start: number;
  text?: string;
  title?: string;
}

/**
 * 抽取遗留会话引用指令块（剥离用）：单/三冒号、智能引号、参数顺序不一都要认。
 * 代码块内的不收（协议示例有意展示原文）。参数解析失败的也收下，调用方整段丢弃，
 * 避免 `session=`/`title=` 字段泄漏给用户。
 */
export function extractLegacyZCodeSessionCitationDirectives(
  content: string,
): LegacyZCodeSessionCitationDirective[] {
  if (!content.includes(LEGACY_ZCODE_SESSION_CITATION_DIRECTIVE_NAME)) return [];
  const protectedRanges = findMarkdownCodeRanges(content);
  return extractAssistantDirectives(
    content,
    LEGACY_ZCODE_SESSION_CITATION_DIRECTIVE_NAME,
    LEGACY_ZCODE_SESSION_CITATION_SYNTAX,
  ).flatMap((directive) => {
    if (overlapsAssistantTextRanges(directive.start, directive.start + 1, protectedRanges)) {
      return [];
    }
    const text = directive.parameters?.text?.trim();
    const title = directive.parameters?.title?.trim();
    return [
      {
        start: directive.start,
        end: directive.end,
        raw: content.slice(directive.start, directive.end),
        ...(text ? { text } : {}),
        ...(title ? { title } : {}),
      },
    ];
  });
}

/**
 * 遗留指令块最小剥离：用 `text` 值作纯文本展示，没有 `text` 时退 `title`，
 * 都没有就整段丢弃。不做芯片、不可点、不投影成链接。
 * 原因：遗留语法是内部协议文本，原样显示会把 `session=`/`segment=`/`title=` 字段
 * 暴露给用户；只留人类可读的片段文本。
 */
export function replacementForLegacyZCodeSessionCitationDirective(
  directive: LegacyZCodeSessionCitationDirective,
): string {
  return directive.text?.trim() || directive.title?.trim() || "";
}

/**
 * 对正文做遗留指令块剥离（代码块内受保护）。调用方在各自的投影/导出/索引入口使用，
 * 与 ycode 链接剥离叠加：本函数只处理遗留指令块，ycode 链接由各自原有逻辑处理。
 */
export function stripLegacyZCodeSessionCitationDirectives(content: string): string {
  const directives = extractLegacyZCodeSessionCitationDirectives(content);
  if (directives.length === 0) return content;
  let result = content;
  for (const directive of [...directives].reverse()) {
    const replacement = replacementForLegacyZCodeSessionCitationDirective(directive);
    result = `${result.slice(0, directive.start)}${replacement}${result.slice(directive.end)}`;
  }
  return result;
}

/**
 * 遗留指令块投影（Streamdown/纯文本之前，无条件使用，与引用开关无关）：
 * 闭合块换成纯文本；流式时再截掉尾部未闭合半截，避免 `:::zcode…` 半截闪现。
 * 这是「剥离/隐藏遗留语法」，不是恢复兼容：不做芯片、不可点、不投影成链接。
 */
export function projectLegacyZCodeSessionCitationDirectives(
  content: string,
  options: { streaming: boolean },
): string {
  const stripped = stripLegacyZCodeSessionCitationDirectives(content);
  return options.streaming ? truncateUnclosedLegacyDirectiveTail(stripped) : stripped;
}

/**
 * 流式尾部未闭合遗留指令块的起点定位：闭合块走上面的整段剥离（纯文本替换，
 * 不需要存在性校验）；未闭合尾巴直接截掉，避免 `:::zcode…` 半截闪现。
 * 代码块内的不动。返回 null = 无需处理。
 */
export function findUnclosedLegacyZCodeSessionCitationStart(content: string): number | null {
  // fast-path 用 `:::zcode` 而非完整指令名：流式半截可能指令名都没写全，
  // 只要冒号前缀已出现就进 parser 精判，避免半截原文闪现。
  if (!content.includes(":::zcode") && !content.includes(":zcode-session-citation")) return null;
  const protectedRanges = findMarkdownCodeRanges(content);
  const unclosedStart = findUnclosedAssistantDirectiveStart(
    content,
    LEGACY_ZCODE_SESSION_CITATION_DIRECTIVE_NAME,
    protectedRanges,
    LEGACY_ZCODE_SESSION_CITATION_SYNTAX,
  );
  if (unclosedStart !== null) return unclosedStart;
  const prefixStart = findAssistantDirectivePrefixStart(
    content,
    [LEGACY_ZCODE_SESSION_CITATION_DIRECTIVE_NAME],
    protectedRanges,
    {
      minimumSingleColonPrefixLength: LEGACY_ZCODE_SESSION_CITATION_SINGLE_COLON_PREFIX_LENGTH,
      singleColonDirectiveNames: [LEGACY_ZCODE_SESSION_CITATION_DIRECTIVE_NAME],
      tripleColonDirectiveNames: [LEGACY_ZCODE_SESSION_CITATION_DIRECTIVE_NAME],
    },
  );
  return prefixStart;
}

/**
 * 构建会话引用链接（ycode 双参规范式）：
 * `ycode://session/open?sessionId=<id>&search=<编码>`。
 * 调用方（prompt 示例、单测）传入原文片段，这里只做 percent-encode——markdown 看整串
 * URL 就是不透明文本，`*`/反引号/空格切不碎。
 */
export function buildZCodeSessionCitationUrl(citation: { session: string; text?: string }): string {
  const params = new URLSearchParams();
  params.set("sessionId", citation.session);
  if (citation.text) params.set("search", citation.text);
  return (
    `${ZCODE_SESSION_CITATION_YCODE_SCHEME}//${ZCODE_SESSION_CITATION_YCODE_HOST}` +
    `${ZCODE_SESSION_CITATION_YCODE_ACTION_PATH}?${params.toString()}`
  );
}

export interface ParsedZCodeSessionCitationUrl {
  session: string;
  text?: string;
}

/** session id 格式：非空、无空白与 URL 分隔符；外部深链入口同样用它做严格校验。 */
function parseSessionIdToken(value: string | null | undefined): string | null {
  const token = value?.trim() ?? "";
  if (!token || /[\s/?#]/.test(token)) return null;
  return token;
}

function readCitationQueryParams(params: URLSearchParams, parsed: ParsedZCodeSessionCitationUrl) {
  // 参数名 search 为规范，text 为旧名兼容；两者都接受。
  // 中文与空格可不编码（URLSearchParams 原生容忍）；&、#、? 必须由产出方编码或改写避开。
  const text = params.get("search")?.trim() || params.get("text")?.trim();
  if (text) parsed.text = text;
}

/**
 * 解析会话引用链接，只认 `ycode://session/open?sessionId=<id>&search=…`（规范式）。
 * - 其他 host/path：不认，返回 null（只认 session/open）；
 * - 旧 `zcode-session:` 形态：已清除，返回 null（老内容按普通文本显示）；
 * - sessionId 缺席/空白/格式非法：返回 null（调用方只呈现链接文本，不露裸 URL）。
 */
export function parseZCodeSessionCitationUrl(url: string): ParsedZCodeSessionCitationUrl | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(ZCODE_SESSION_CITATION_YCODE_SCHEME)) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsedUrl.hostname !== ZCODE_SESSION_CITATION_YCODE_HOST ||
    parsedUrl.pathname !== ZCODE_SESSION_CITATION_YCODE_ACTION_PATH
  ) {
    return null;
  }
  const session = parseSessionIdToken(parsedUrl.searchParams.get("sessionId"));
  if (!session) return null;
  const parsed: ParsedZCodeSessionCitationUrl = { session };
  try {
    readCitationQueryParams(parsedUrl.searchParams, parsed);
  } catch {
    // query 解析失败不影响 session 本体：照无载荷处理。
  }
  return parsed;
}

/** 只取 session，调用方不需要载荷时用。 */
export function parseZCodeSessionCitationSessionId(url: string): string | null {
  return parseZCodeSessionCitationUrl(url)?.session ?? null;
}

/**
 * 构建流式占位链接：`ycode://session/pending?sessionId=<id>`。
 * 只在 streaming 投影里出现，由 message.tsx 的 `a` 渲染器画成固定最小宽度占位芯片；
 * sanitize 按 ycode scheme 放行。
 */
export function buildZCodeSessionCitationPendingUrl(session: string): string {
  const params = new URLSearchParams();
  params.set("sessionId", session);
  return (
    `${ZCODE_SESSION_CITATION_YCODE_SCHEME}//${ZCODE_SESSION_CITATION_YCODE_HOST}` +
    `${ZCODE_SESSION_CITATION_YCODE_PENDING_ACTION_PATH}?${params.toString()}`
  );
}

/** 解析流式占位链接，命中则返回 session，否则 null（普通 open 链接不归这里管）。 */
export function parseZCodeSessionCitationPendingSessionId(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(ZCODE_SESSION_CITATION_YCODE_SCHEME)) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsedUrl.hostname !== ZCODE_SESSION_CITATION_YCODE_HOST ||
    parsedUrl.pathname !== ZCODE_SESSION_CITATION_YCODE_PENDING_ACTION_PATH
  ) {
    return null;
  }
  return parseSessionIdToken(parsedUrl.searchParams.get("sessionId"));
}

/**
 * 抽取正文里的 ycode 会话引用链接：返回闭合 Markdown 链接中 href 为
 * `ycode://session/open` 的条目（session 非法的不收，调用方只呈现链接文本）。
 * 代码块内的不收。纯函数；来源抽取与单测共用。
 */
const SESSION_CITATION_LINK_PATTERN =
  /\[((?:[^\]\\]|\\.)*)\]\(\s*(ycode:\/\/session\/open\?[^\s)]*)\s*\)/g;

export function extractZCodeSessionCitationLinks(content: string): ZCodeSessionCitationLink[] {
  if (!content.includes("ycode://session/open")) return [];
  const protectedRanges = findMarkdownCodeRanges(content);
  const out: ZCodeSessionCitationLink[] = [];
  for (const match of content.matchAll(SESSION_CITATION_LINK_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0] ?? "";
    if (overlapsAssistantTextRanges(start, start + 1, protectedRanges)) continue;
    const parsed = parseZCodeSessionCitationUrl(match[2] ?? "");
    if (!parsed) continue;
    // 链文转义还原：`]` 在 markdown 里写成 `\]`，文本语义取还原后。
    const text = (match[1] ?? "").replace(/\\(.)/g, "$1");
    out.push({ session: parsed.session, start, end: start + raw.length, raw, text, ...(parsed.text ? { search: parsed.text } : {}) });
  }
  return out;
}

/**
 * 从未闭合 Markdown 链接尾巴里提取已写出的 sessionId：
 * 形如 `[部分文本](ycode://session/open?sessionId=sess_x&sea…`。
 * 拿不到 sessionId 时返回 null（调用方不补位，走正常 markdown 流式）。
 */
export function parsePendingSessionCitationSessionId(unclosedTail: string): string | null {
  const markerIndex = unclosedTail.lastIndexOf("ycode://session/open?");
  if (markerIndex < 0) return null;
  const query = unclosedTail.slice(markerIndex + "ycode://session/open?".length);
  const match = query.match(/(?:^|[&?])sessionId\s*=\s*([^&#\s)]*)/);
  const session = (match?.[1] ?? "").trim();
  if (!session || /[\s/?#]/.test(session)) return null;
  return session;
}

/**
 * 流式投影（Streamdown 之前）+ 遗留指令块剥离。
 * - 遗留指令块：完成态与流式都要剥离（闭合块换成纯文本；流式尾部未闭合半截截掉，
 *   避免 `:::zcode…` 半截闪现）。这是「剥离/隐藏遗留语法」，不是恢复兼容：
 *   不做芯片、不可点、不投影成链接。
 * - ycode 链接：只处理尾部未闭合的（见原注释）；闭合链接不需要预解析。
 */
export function projectZCodeSessionCitations(
  content: string,
  options: { streaming: boolean; existingSessionIds?: ReadonlySet<string> },
): ZCodeSessionCitationProjection {
  // 遗留指令块先剥离：闭合块换纯文本；流式再截尾部未闭合半截。
  const stripped = stripLegacyZCodeSessionCitationDirectives(content);
  const truncated = options.streaming ? truncateUnclosedLegacyDirectiveTail(stripped) : stripped;
  if (!options.streaming || !truncated) {
    return { visibleText: truncated };
  }
  const unclosedStart = findUnclosedSessionCitationLinkStart(truncated);
  if (unclosedStart === null) return { visibleText: truncated };
  const base = truncated.slice(0, unclosedStart);
  const pendingSessionId = parsePendingSessionCitationSessionId(truncated.slice(unclosedStart));
  if (!pendingSessionId) return { visibleText: base };
  if (options.existingSessionIds && !options.existingSessionIds.has(pendingSessionId)) {
    return { visibleText: base, pendingSessionId };
  }
  return {
    visibleText: `${base}[引用会话中](${buildZCodeSessionCitationPendingUrl(pendingSessionId)})`,
    pendingSessionId,
  };
}

/**
 * 截掉流式尾部未闭合的遗留指令块半截（含刚写出的 `:::` 前缀）。
 * 闭合块已在上一步换成纯文本，这里只处理还悬着的尾巴。
 */
function truncateUnclosedLegacyDirectiveTail(content: string): string {
  const unclosedStart = findUnclosedLegacyZCodeSessionCitationStart(content);
  return unclosedStart === null ? content : content.slice(0, unclosedStart);
}

/**
 * 定位尾部未闭合的 ycode 引用链接起点：最后一个 `[` 之后出现 `](ycode://session/open?`
 * 且其后没有 `)` 闭合。代码块内的不算。返回 null = 无需占位。
 */
function findUnclosedSessionCitationLinkStart(content: string): number | null {
  const protectedRanges = findMarkdownCodeRanges(content);
  const openBracket = content.lastIndexOf("[");
  if (openBracket < 0) return null;
  if (overlapsAssistantTextRanges(openBracket, openBracket + 1, protectedRanges)) return null;
  const marker = content.indexOf("](ycode://session/open?", openBracket);
  if (marker < 0) return null;
  const closeParen = content.indexOf(")", marker + 2);
  if (closeParen >= 0) return null;
  return openBracket;
}
