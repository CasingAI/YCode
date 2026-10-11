import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
  overlapsAssistantTextRanges,
} from "@/lib/assistantDirectiveParser.js";

// 模型在正文里写会话引用：应用到其它会话原文的锚点（docs/specs/assistant-session-citation.md）。
// 复用文件引用指令同一套解析与流式投影模式：参数用 `{k=v,}` 非 JSON，智能引号、单/三冒号
// 全开，兼容模型的误写；代码块内的样例不参与解析与隐藏。
export interface ZCodeSessionCitation {
  end: number;
  raw: string;
  /** 目标会话 id（必填）。 */
  session: string;
  /** 段号提示（可选，跳转定位以 text 为准，不靠段号）。 */
  segment?: number;
  start: number;
  /** 原文片段（推荐，跳转后用于搜索高亮）。 */
  text?: string;
  /** 展示名（可选，缺席时调用方回退会话标题）。 */
  title?: string;
}

interface ZCodeSessionCitationProjection {
  visibleText: string;
}

export const ZCODE_SESSION_CITATION_DIRECTIVE_NAME = "zcode-session-citation";
// 旧内部 scheme（不透明形态）：只做向后兼容解析，新产出统一用 YCODE 式。
export const ZCODE_SESSION_CITATION_URL_SCHEME = "zcode-session:";
/** ycode 系统协议：scheme 固定 ycode，与 zcode 并存，不替换现有深链。 */
export const ZCODE_SESSION_CITATION_YCODE_SCHEME = "ycode:";
/** ycode 会话引用 host：固定字面量，session id 放 path（host 受 URL 规范化约束）。 */
export const ZCODE_SESSION_CITATION_YCODE_HOST = "session";
/** ycode 会话引用动作 path：跟 zcode://workspace/open 同约定（host 为域、path 为动作）。 */
export const ZCODE_SESSION_CITATION_YCODE_ACTION_PATH = "/open";
const ZCODE_SESSION_CITATION_SINGLE_COLON_PREFIX_LENGTH = ":zcode".length;
const ZCODE_SESSION_CITATION_SYNTAX = {
  allowSingleColon: true,
  allowSmartQuotes: true,
  allowTripleColon: true,
} as const;

function parseSegment(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

/** 抽取正文里的会话引用指令：session 为空或代码块内的都丢掉。 */
export function extractZCodeSessionCitations(content: string): ZCodeSessionCitation[] {
  const protectedRanges = findMarkdownCodeRanges(content);
  return extractAssistantDirectives(
    content,
    ZCODE_SESSION_CITATION_DIRECTIVE_NAME,
    ZCODE_SESSION_CITATION_SYNTAX,
  ).flatMap((directive) => {
    if (
      !directive.parameters ||
      overlapsAssistantTextRanges(directive.start, directive.start + 1, protectedRanges)
    ) {
      return [];
    }
    const session = directive.parameters.session?.trim();
    // session 缺席的引用是模型半成品：渲染与锚点都无意义，丢掉而不是渲染死链。
    if (!session) return [];
    const text = directive.parameters.text?.trim();
    const title = directive.parameters.title?.trim();
    const segment = parseSegment(directive.parameters.segment);
    return [
      {
        session,
        start: directive.start,
        end: directive.end,
        raw: directive.raw,
        ...(text ? { text } : {}),
        ...(title ? { title } : {}),
        ...(segment !== undefined ? { segment } : {}),
      },
    ];
  });
}

/**
 * 构建会话引用链接（ycode 双参规范式）：
 * `ycode://session/open?sessionId=<id>&search=<编码>`。
 * search 片段由调用方清洗后传入，这里只做 percent-encode——markdown 看整串
 * URL 就是不透明文本，`*`/反引号/空格切不碎。只收双参，多余的不产出。
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
  segment?: number;
  title?: string;
}

/** session id 格式：非空、无空白与 URL 分隔符；外部深链入口同样用它做严格校验。 */
function parseSessionIdToken(value: string | null | undefined): string | null {
  const token = value?.trim() ?? "";
  if (!token || /[\s/?#]/.test(token)) return null;
  return token;
}

function readCitationQueryParams(params: URLSearchParams, parsed: ParsedZCodeSessionCitationUrl) {
  // 参数名 search 为规范（用户选定），text 为旧名兼容；两者都接受。
  const text = params.get("search")?.trim() || params.get("text")?.trim();
  if (text) parsed.text = text;
  const segmentRaw = params.get("segment");
  if (segmentRaw && /^\d+$/.test(segmentRaw)) {
    const segment = Number.parseInt(segmentRaw, 10);
    if (segment > 0) parsed.segment = segment;
  }
  const title = params.get("title")?.trim();
  if (title) parsed.title = title;
}

/**
 * 解析会话引用链接，三种形态都接受（旧快照与现有单测不断）：
 * 1. `ycode://session/open?sessionId=<id>&search=…`（规范式）；
 * 2. `ycode://…` 其他 host/path：不认，返回 null（只认 session/open）；
 * 3. `zcode-session:<id>?text=…`（旧不透明式）。
 */
export function parseZCodeSessionCitationUrl(url: string): ParsedZCodeSessionCitationUrl | null {
  const trimmed = url.trim();
  if (trimmed.startsWith(ZCODE_SESSION_CITATION_YCODE_SCHEME)) {
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
  if (!trimmed.startsWith(ZCODE_SESSION_CITATION_URL_SCHEME)) return null;
  const rest = trimmed.slice(ZCODE_SESSION_CITATION_URL_SCHEME.length);
  const queryIndex = rest.indexOf("?");
  const session = parseSessionIdToken(queryIndex < 0 ? rest : rest.slice(0, queryIndex));
  if (!session) return null;
  const parsed: ParsedZCodeSessionCitationUrl = { session };
  if (queryIndex >= 0) {
    try {
      readCitationQueryParams(new URLSearchParams(rest.slice(queryIndex + 1)), parsed);
    } catch {
      // query 解析失败不影响 session 本体：照无载荷处理。
    }
  }
  return parsed;
}

/** 旧单参形态兼容：只取 session，调用方不需要载荷时用。 */
export function parseZCodeSessionCitationSessionId(url: string): string | null {
  return parseZCodeSessionCitationUrl(url)?.session ?? null;
}

/**
 * 预解析（Streamdown 之前）：把闭合的会话引用指令换成标准 markdown 链接
 * `[片段](ycode://session/open?sessionId=…&search=…)`，片段由我方 percent-encode
 * 进 URL——markdown 只负责把链接解析成 `a` 节点，`*`/反引号/空格切不碎。
 * 白名单判定留在这里：白名单外留原文（与 remark 插件同语义），代码块内不转。
 * 流式时未闭合尾巴继续隐藏（现有逻辑不动），只转已闭合部分。
 * 异常输出若已换行继续正文则保留原文，避免一个缺失 `}` 的指令把后续回答全部吞掉；
 * 代码块中的协议样例不参与转换与隐藏。
 */
/**
 * 闭合指令转标准 markdown 链接：白名单内（或不校验时）的指令换成
 * `[片段](ycode://session/open?sessionId=…&search=…)`，链文取 text
 * 否则取 title、再否则取 session。白名单外与代码块内留原文。
 * 纯函数；调用方（message.tsx 预解析、单测）共用。
 */
export function convertZCodeSessionCitationsToLinks(
  content: string,
  allowedSessionIds?: ReadonlySet<string>,
): string {
  if (!content) return content;
  const citations = extractZCodeSessionCitations(content);
  if (citations.length === 0) return content;
  let out = "";
  let cursor = 0;
  for (const citation of citations) {
    if (allowedSessionIds && !allowedSessionIds.has(citation.session)) {
      // 白名单外：留原文，与 remark 插件同语义。
      continue;
    }
    const label = citation.text?.trim() || citation.title?.trim() || citation.session;
    // 链文里的 `]` 会提前闭合 markdown 链接：转义后 markdown 仍解析出同一文本。
    const safeLabel = label.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
    const url = buildZCodeSessionCitationUrl({
      session: citation.session,
      ...(citation.text ? { text: citation.text } : {}),
    });
    out += content.slice(cursor, citation.start) + `[${safeLabel}](${url})`;
    cursor = citation.end;
  }
  if (cursor === 0) return content;
  return out + content.slice(cursor);
}

export function projectZCodeSessionCitations(
  content: string,
  options: { streaming: boolean; allowedSessionIds?: ReadonlySet<string> },
): ZCodeSessionCitationProjection {
  const converted = convertZCodeSessionCitationsToLinks(content, options.allowedSessionIds);
  if (!options.streaming || !converted) return { visibleText: converted };

  const protectedRanges = findMarkdownCodeRanges(converted);
  const unclosedStart = findUnclosedAssistantDirectiveStart(
    converted,
    ZCODE_SESSION_CITATION_DIRECTIVE_NAME,
    protectedRanges,
    ZCODE_SESSION_CITATION_SYNTAX,
  );
  if (unclosedStart === null) {
    const prefixStart = findAssistantDirectivePrefixStart(
      converted,
      ["code-comment", "zcode-file-citation", ZCODE_SESSION_CITATION_DIRECTIVE_NAME],
      protectedRanges,
      {
        minimumSingleColonPrefixLength: ZCODE_SESSION_CITATION_SINGLE_COLON_PREFIX_LENGTH,
        singleColonDirectiveNames: ["zcode-file-citation", ZCODE_SESSION_CITATION_DIRECTIVE_NAME],
        tripleColonDirectiveNames: ["zcode-file-citation", ZCODE_SESSION_CITATION_DIRECTIVE_NAME],
      },
    );
    return prefixStart === null
      ? { visibleText: converted }
      : { visibleText: converted.slice(0, prefixStart) };
  }

  return {
    visibleText: converted.slice(0, unclosedStart),
  };
}
