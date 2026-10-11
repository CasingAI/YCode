import type { Plugin } from "unified";
import {
  buildZCodeSessionCitationUrl,
  extractZCodeSessionCitations,
} from "@/lib/zcodeSessionCitation.js";

interface SessionCitationMarkdownNode {
  children?: SessionCitationMarkdownNode[];
  title?: string;
  type: string;
  url?: string;
  value?: string;
}

// remark 投影兜底：把正文里的会话引用指令转成 mdast link。
// 首选路径是预解析（projectZCodeSessionCitations 在 markdown 之前转成
// `[片段](ycode://…)`，切不碎）；这里只接直接传裸指令的调用方。
// url 统一 ycode 双参式，载荷编码进 query——mdast→hast 不保证透传自定义 data。
// 后续由 message.tsx 的通用 `a` 渲染器按 scheme 分流到会话芯片。
//
// 白名单在插件入口处过滤：不在 allowedSessionIds 里的引用不投影成 link，
// 指令原文留在正文里当普通文本（校验不通过 = 不可点、无死链）。
// allowedSessionIds 缺席 = 调用方不校验，全部投影。
const SKIPPED_PARENT_TYPES = new Set(["code", "html", "image", "inlineCode", "link"]);

function projectSessionCitationTextNode(
  node: SessionCitationMarkdownNode,
  allowedSessionIds?: ReadonlySet<string>,
): SessionCitationMarkdownNode[] | null {
  const value = node.value ?? "";
  const citations = extractZCodeSessionCitations(value);
  if (citations.length === 0) return null;

  const nextNodes: SessionCitationMarkdownNode[] = [];
  let cursor = 0;
  for (const citation of citations) {
    if (allowedSessionIds && !allowedSessionIds.has(citation.session)) {
      // 白名单不通过：跳过投影，该段指令原文保留为普通文本。
      continue;
    }
    if (citation.start > cursor) {
      nextNodes.push({ type: "text", value: value.slice(cursor, citation.start) });
    }
    // 芯片文案：search 片段优先（跳转后即搜它，所见即所得），否则用 title，
    // 再否则用 session 做兜底；调用方拿到 display 名后再替换，本插件只保证
    // 渲染有字、不显示裸 sessionId。
    const fallbackLabel = citation.text?.trim() || citation.title?.trim() || citation.session;
    nextNodes.push({
      type: "link",
      url: buildZCodeSessionCitationUrl({
        session: citation.session,
        ...(citation.text ? { text: citation.text } : {}),
      }),
      title: citation.session,
      children: [{ type: "text", value: fallbackLabel }],
    });
    cursor = citation.end;
  }
  if (cursor === 0) return null;
  if (cursor < value.length) {
    nextNodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nextNodes;
}

function transformSessionCitationChildren(
  node: SessionCitationMarkdownNode,
  allowedSessionIds?: ReadonlySet<string>,
): void {
  if (!node.children || SKIPPED_PARENT_TYPES.has(node.type)) return;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]!;
    if (child.type === "text") {
      const replacement = projectSessionCitationTextNode(child, allowedSessionIds);
      if (replacement) {
        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
      continue;
    }
    transformSessionCitationChildren(child, allowedSessionIds);
  }
}

export function createZCodeSessionCitationRemarkPlugin(
  allowedSessionIds?: ReadonlySet<string>,
): Plugin {
  return function zcodeSessionCitationRemarkPlugin() {
    return (tree: unknown) => {
      transformSessionCitationChildren(tree as SessionCitationMarkdownNode, allowedSessionIds);
    };
  };
}
