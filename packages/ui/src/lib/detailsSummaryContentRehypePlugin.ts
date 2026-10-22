import type { Plugin } from "unified";

interface HastNode {
  children?: HastNode[];
  tagName?: string;
  type?: string;
}

/**
 * HTML 规范里 `<summary>` 的内容模型是「phrasing 内容，或一个 heading 内容」。
 * 表格、列表、代码块这类块级内容出现在 summary 内属于非法结构。
 *
 * 模型输出的 Markdown 里 `<summary>` 漏写闭合标签很常见（真实会话里就有
 * `<summary>相关代码与数据位置` 这种写法）。浏览器解析器遇到块级标签不会
 * 提前闭合 summary，而是一直挂到 `</details>` 才收口，于是整张表格变成
 * summary 的子节点。渲染层再把 summary 的全部子节点提成折叠卡标题，表格
 * 就落进标题按钮的 truncate 容器里：右侧列被裁掉、且无法横向查看。
 *
 * 这里在解析层把非法块级内容从 summary 里搬出来，放到同一个 details 内、
 * 紧跟 summary 之后，恢复成「标题 + 正文」的正常结构。
 */
const blockLevelTagNames = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "dd",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/**
 * heading 内容（h1-h6）是 summary 允许的标题形态，不算非法块级内容，
 * 保持在 summary 内当标题用。
 */
function isBlockLevelChild(node: HastNode): boolean {
  if (node.type !== "element") return false;
  if (typeof node.tagName !== "string") return false;
  return blockLevelTagNames.has(node.tagName);
}

/**
 * 把 summary 的块级子节点摘出来，返回被摘走的节点；summary 里没有非法内容时
 * 返回空数组，原样保留。
 */
function splitSummaryChildren(summary: HastNode): HastNode[] {
  const children = summary.children;
  if (!children || children.length === 0) return [];

  const kept: HastNode[] = [];
  const moved: HastNode[] = [];
  for (const child of children) {
    if (isBlockLevelChild(child)) {
      moved.push(child);
    } else {
      kept.push(child);
    }
  }

  if (moved.length === 0) return [];
  summary.children = kept;
  return moved;
}

/**
 * 深度优先遍历：先把 summary 的非法块级内容搬出来，再继续处理搬走节点内部的
 * 嵌套折叠块，保证内层 details 也得到同样归位。
 */
function normalizeDetailsTree(node: HastNode): void {
  const children = node.children;
  if (!children || children.length === 0) return;

  const next: HastNode[] = [];
  for (const child of children) {
    normalizeDetailsTree(child);
    next.push(child);

    if (child.type === "element" && child.tagName === "summary") {
      // 搬出来的块级内容放到同一个 details 内、紧跟 summary 之后，
      // 落在折叠区正文里而不是卡片标题里。
      next.push(...splitSummaryChildren(child));
    }
  }
  node.children = next;
}

/**
 * rehype 插件：修正 `<summary>` 内非法块级内容的归属。
 *
 * 必须挂在 `rehype-raw` 之后执行：原始 Markdown 里的 `<details>` / `<summary>`
 * 是 HTML 字符串，要先被 rehype-raw 解析成真实节点，才谈得上搬运子节点。
 */
export const detailsSummaryContentRehypePlugin: Plugin =
  function detailsSummaryContentRehypePlugin() {
    return (tree: unknown) => {
      normalizeDetailsTree(tree as HastNode);
    };
  };
