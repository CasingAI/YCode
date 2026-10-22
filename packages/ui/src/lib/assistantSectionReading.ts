import { marked, type TokensList } from "marked";
import { decodeHTML } from "entities";

export interface AssistantReadingSection {
  id: string;
  title: string;
  markdown: string;
  startOffset: number;
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
  const introTokens = rootTokens.filter(
    (entry) => entry.start < firstHeading.start && entry.token.type !== "def",
  );
  if (introTokens.some((entry) => isVisibleRootToken(entry.token))) {
    sections.push({
      id: `intro-${firstHeading.start}`,
      title: "",
      markdown: pageMarkdown(rootTokens, 0, firstHeading.start, definitions),
      startOffset: 0,
    });
  }

  splitHeadings.forEach((heading, index) => {
    const next = splitHeadings[index + 1];
    const end = next?.start ?? markdown.length;
    sections.push({
      id: `section-${index}-${heading.start}`,
      // 实体解码可能新增 NBSP 等空白，需在解码后与 DOM 标题使用相同的空白规范化口径。
      title: normalizeAssistantSectionHeadingText(
        decodeHTML(visibleInlineText(heading.token.tokens ?? [])),
      ),
      markdown: pageMarkdown(rootTokens, heading.start, end, definitions),
      startOffset: heading.start,
    });
  });

  if (sections.filter((section) => section.title.length > 0).length < 2) return undefined;
  return { version: hashText(markdown), sections, splitHeadingDepth };
}
