import { marked, type TokensList } from "marked";
import { decodeHTML } from "entities";

export interface AssistantReadingSection {
  id: string;
  title: string;
  markdown: string;
  startOffset: number;
  /**
   * 纯派生展示提示：本节只含短纯文本（无代码/表格/列表/引用/图片/HTML 等结构）时存在。
   * UI 可据此使用既有 text-ui-lg / text-ui-xl 层级强调，结构化内容永远不应出现该字段。
   */
  presentation?: {
    /** 极短内容建议 xl，其余建议 lg；只影响纯文字，不改变代码/表格/列表字号。 */
    emphasis: "lg" | "xl";
  };
}

export interface AssistantSectionDocument {
  version: string;
  sections: AssistantReadingSection[];
  splitHeadingDepth: number;
}

interface RootToken {
  token: ReturnType<typeof marked.lexer>[number];
  start: number;
  end: number;
}

export function normalizeAssistantSectionHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${hash >>> 0}`;
}

function isVisibleRootToken(token: RootToken["token"]): boolean {
  if (token.type === "space" || token.type === "def") return false;
  // 只有 HTML 块里的注释不可见；代码块中的同样字符是示例内容，不能从分节页删除。
  const visibleSource =
    token.type === "html" ? token.raw.replace(/<!--[\s\S]*?-->/g, "") : token.raw;
  return visibleSource.trim().length > 0;
}

// 纯短内容只用于可选的视觉强调；结构化内容不能因为字符少而被放大。
const COMPACT_PLAIN_TEXT_MAX_LENGTH = 120;
const COMPACT_PLAIN_TEXT_XL_MAX_LENGTH = 40;

function isCompactPlainInlineToken(token: unknown): boolean {
  if (typeof token !== "object" || token === null) return true;
  const candidate = token as { type?: string; tokens?: unknown[] };
  switch (candidate.type) {
    case "text":
    case "escape":
    case "br":
      return true;
    case "strong":
    case "em":
    case "del":
    case "link":
      return (candidate.tokens ?? []).every(isCompactPlainInlineToken);
    default:
      // codespan、image、inline html 等有自己的排版语义，不能整体放大。
      return false;
  }
}

/**
 * 返回整页可见纯文本；只要出现结构化 block/inline token 就返回 undefined。
 */
function compactPlainText(tokens: readonly RootToken[]): string | undefined {
  let text = "";
  for (const entry of tokens) {
    const token = entry.token;
    if (token.type === "space" || token.type === "def") continue;
    if (token.type !== "heading" && token.type !== "paragraph") {
      // 仅 HTML 注释仍算不可见；其它 HTML、代码、表格、列表、引用等都不属于纯文本。
      if (token.type === "html" && !isVisibleRootToken(token)) continue;
      return undefined;
    }
    const inlineTokens = token.tokens ?? [];
    if (!inlineTokens.every(isCompactPlainInlineToken)) return undefined;
    const visibleText =
      inlineTokens.length > 0
        ? visibleInlineText(inlineTokens)
        : normalizeAssistantSectionHeadingText(token.text ?? "");
    if (visibleText.length > 0) text += `${visibleText} `;
  }
  return text.trim();
}

function sectionPresentation(
  tokens: readonly RootToken[],
): AssistantReadingSection["presentation"] {
  const text = compactPlainText(tokens);
  if (text === undefined || text.length === 0 || text.length > COMPACT_PLAIN_TEXT_MAX_LENGTH) {
    return undefined;
  }
  return {
    emphasis: text.length <= COMPACT_PLAIN_TEXT_XL_MAX_LENGTH ? "xl" : "lg",
  };
}

function isShallowerHeadingToken(entry: RootToken, depth: number): boolean {
  return entry.token.type === "heading" && entry.token.depth < depth;
}

function tokensInRange(tokens: readonly RootToken[], start: number, end: number): RootToken[] {
  return tokens.filter(
    (entry) => entry.token.type !== "def" && entry.start >= start && entry.end <= end,
  );
}

function visibleInlineText(tokens: readonly unknown[]): string {
  const source = tokens
    .map((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return "";
      const token = candidate as {
        type?: string;
        text?: string;
        raw?: string;
        tokens?: unknown[];
      };
      if (token.type === "br") return " ";
      if (token.type === "image") return token.text ?? "";
      if (token.tokens) return visibleInlineText(token.tokens);
      if (token.type === "html") return (token.raw ?? "").replace(/<[^>]*>/g, "");
      return token.text ?? "";
    })
    .join("");
  return normalizeAssistantSectionHeadingText(source);
}

function hasUnsupportedCrossPageLink(markdown: string, tokens: TokensList): boolean {
  let hasLocalAnchor = false;
  marked.walkTokens(tokens, (token) => {
    if (token.type === "link" && token.href.startsWith("#")) {
      hasLocalAnchor = true;
    }
  });
  // GFM footnotes are part of Streamdown's parser. A page-local parse cannot safely preserve
  // footnote numbering/backlinks across independently rendered pages, so keep the source whole.
  return hasLocalAnchor || /\[\^[^\]]+\]/.test(markdown) || /\bhref\s*=\s*["']#/i.test(markdown);
}

function hasSameDepthHtmlHeading(tokens: TokensList, depth: number): boolean {
  const headingTag = new RegExp(`<h${depth}(?=[\\s/>])`, "i");
  let found = false;
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "html") return;
    if (headingTag.test(token.raw.replace(/<!--[\s\S]*?-->/g, ""))) found = true;
  });
  return found;
}

function pageMarkdown(
  tokens: readonly RootToken[],
  start: number,
  end: number,
  definitions: string[],
) {
  const page = tokens
    .filter((entry) => entry.token.type !== "def" && entry.start >= start && entry.end <= end)
    .map((entry) => entry.token.raw)
    .join("");
  return definitions.length > 0 ? `${page}\n\n${definitions.join("\n")}` : page;
}

/**
 * 按 Markdown 根级 block token 切分最终正文。无法保留跨页语义时返回 undefined，调用方应显示全文。
 */
export function buildAssistantSectionDocument(
  markdown: string,
): AssistantSectionDocument | undefined {
  if (!markdown.trim()) return undefined;

  const parsed = marked.lexer(markdown);
  if (hasUnsupportedCrossPageLink(markdown, parsed)) return undefined;
  const rootTokens: RootToken[] = [];
  let offset = 0;
  for (const token of parsed) {
    const start = offset;
    offset += token.raw.length;
    rootTokens.push({ token, start, end: offset });
  }
  // A tokenizer/source mismatch is safer as continuous text than a page that silently drops bytes.
  if (offset !== markdown.length) return undefined;

  const headings = rootTokens.filter(
    (entry): entry is RootToken & { token: Extract<RootToken["token"], { type: "heading" }> } =>
      entry.token.type === "heading",
  );
  const countsByDepth = new Map<number, number>();
  for (const entry of headings) {
    countsByDepth.set(entry.token.depth, (countsByDepth.get(entry.token.depth) ?? 0) + 1);
  }
  const splitHeadingDepth = [...countsByDepth]
    .filter(([, count]) => count >= 2)
    .map(([depth]) => depth)
    .sort((left, right) => left - right)[0];
  if (splitHeadingDepth === undefined) return undefined;
  // renderer 不区分同层 HTML 与 Markdown 标题的来源；出现混用时不能仅凭文字重建全文锚点。
  if (hasSameDepthHtmlHeading(parsed, splitHeadingDepth)) return undefined;

  const splitHeadings = headings.filter((entry) => entry.token.depth === splitHeadingDepth);
  const definitions = rootTokens
    .filter((entry) => entry.token.type === "def")
    .map((entry) => entry.token.raw.trim())
    .filter(Boolean);
  const sections: AssistantReadingSection[] = [];
  const firstHeading = splitHeadings[0]!;
  const prefixTokens = tokensInRange(rootTokens, 0, firstHeading.start);
  const visiblePrefixTokens = prefixTokens.filter((entry) => isVisibleRootToken(entry.token));
  // 只有「一个更浅的根级总标题 + 空白/不可见注释/引用定义」时，总标题是整篇前缀而非导语。
  // 把它并入首节，避免出现仅有标题的空 intro 页，同时让首节 startOffset 覆盖前缀。
  const mergeTitlePrefix =
    visiblePrefixTokens.length === 1 &&
    isShallowerHeadingToken(visiblePrefixTokens[0]!, splitHeadingDepth);
  if (!mergeTitlePrefix && visiblePrefixTokens.length > 0) {
    const presentation = sectionPresentation(prefixTokens);
    sections.push({
      id: `intro-${firstHeading.start}`,
      title: "",
      markdown: pageMarkdown(rootTokens, 0, firstHeading.start, definitions),
      startOffset: 0,
      ...(presentation ? { presentation } : {}),
    });
  }

  splitHeadings.forEach((heading, index) => {
    const next = splitHeadings[index + 1];
    const end = next?.start ?? markdown.length;
    // 合并总标题前缀后，首节的起点回到文档开头，确保展开全文的节首锚点覆盖原总标题。
    const start = index === 0 && mergeTitlePrefix ? 0 : heading.start;
    const presentation = sectionPresentation(tokensInRange(rootTokens, start, end));
    sections.push({
      id: `section-${index}-${heading.start}`,
      // 实体解码可能新增 NBSP 等空白，需在解码后与 DOM 标题使用相同的空白规范化口径。
      title: normalizeAssistantSectionHeadingText(
        decodeHTML(visibleInlineText(heading.token.tokens ?? [])),
      ),
      markdown: pageMarkdown(rootTokens, start, end, definitions),
      startOffset: start,
      ...(presentation ? { presentation } : {}),
    });
  });

  if (sections.filter((section) => section.title.length > 0).length < 2) return undefined;
  return { version: hashText(markdown), sections, splitHeadingDepth };
}
