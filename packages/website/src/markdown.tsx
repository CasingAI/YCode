import { Fragment, type ReactNode } from "react";
import { Link } from "./router.js";

// 站内 Markdown 渲染器：只支持官网内容用到的子集，
// 避免引入 react-markdown 等运行时依赖。
// 块级：atx 标题(1-4)、段落、无序/有序列表、表格、围栏代码块、引用、分隔线。
// 行内：`代码`、**加粗**、[文本](链接)、![说明](图片)。其余语法按纯文本降级。
// 内容由仓库内 .md 经构建期内联提供，渲染默认安全（React 文本转义）。

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lines: string[] }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "hr" };

const CODE_FENCE = /^```[\w-]*\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;
const HR = /^\s*(-{3,}|\*{3,})\s*$/;
const INLINE_TOKEN = /(!\[[^\]]*\]\([^)\s]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function isBlockStarter(line: string): boolean {
  return (
    CODE_FENCE.test(line) ||
    HEADING.test(line) ||
    LIST_ITEM.test(line) ||
    TABLE_ROW.test(line) ||
    line.startsWith(">") ||
    HR.test(line)
  );
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const body = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return body.split("|").map((cell) => cell.trim());
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (CODE_FENCE.test(line)) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !CODE_FENCE.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // 跳过收尾围栏
      blocks.push({ kind: "code", lines: codeLines });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        quoteLines.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "blockquote", lines: quoteLines });
      continue;
    }
    if (TABLE_ROW.test(line)) {
      const header = splitTableRow(line);
      i += 1;
      if (i < lines.length && TABLE_DIVIDER.test(lines[i] ?? "")) i += 1;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        TABLE_ROW.test(lines[i] ?? "") &&
        !TABLE_DIVIDER.test(lines[i] ?? "")
      ) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      const ordered = /\d+\./.test(listItem[2] ?? "");
      const items: string[] = [];
      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i] ?? "");
        if (!match || /\d+\./.test(match[2] ?? "") !== ordered) break;
        items.push(match[3] ?? "");
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraphLines: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !isBlockStarter(lines[i] ?? "")) {
      paragraphLines.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }
  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(
        <Fragment key={`${keyPrefix}-t${index}`}>{text.slice(lastIndex, start)}</Fragment>,
      );
    }
    index += 1;
    const token = match[0];
    lastIndex = start + token.length;
    if (token.startsWith("![")) {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      if (!image) {
        nodes.push(token);
        continue;
      }
      const src = image[2] ?? "";
      // 图片只允许站内相对路径（public 下随构建拷贝），不接受外链与绝对路径。
      if (src.startsWith("/") && !src.startsWith("//")) {
        const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
        nodes.push(
          <img
            key={`${keyPrefix}-i${index}`}
            src={`${base}${src}`}
            alt={image[1] ?? ""}
            loading="lazy"
          />,
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-c${index}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-b${index}`}>{token.slice(2, -2)}</strong>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (!link) {
        nodes.push(token);
        continue;
      }
      const href = link[2] ?? "";
      if (/^https?:\/\//.test(href)) {
        nodes.push(
          <a key={`${keyPrefix}-a${index}`} href={href} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(
          <Link key={`${keyPrefix}-l${index}`} to={href}>
            {link[1]}
          </Link>,
        );
      }
    }
  }
  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-t${index}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case "heading": {
      const content = renderInline(block.text, key);
      if (block.level === 1) return <h1 key={key}>{content}</h1>;
      if (block.level === 2) return <h2 key={key}>{content}</h2>;
      if (block.level === 3) return <h3 key={key}>{content}</h3>;
      return <h4 key={key}>{content}</h4>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.text, key)}</p>;
    case "code":
      return (
        <pre key={key}>
          <code>{block.lines.join("\n")}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={key}>
          {block.lines.map((line, index) => (
            <p key={`${key}-q${index}`}>{renderInline(line, `${key}-q${index}`)}</p>
          ))}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={`${key}-i${index}`}>{renderInline(item, `${key}-i${index}`)}</li>
      ));
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "table":
      return (
        <table key={key}>
          <thead>
            <tr>
              {block.header.map((cell, index) => (
                <th key={`${key}-h${index}`}>{renderInline(cell, `${key}-h${index}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-r${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${key}-r${rowIndex}c${cellIndex}`}>
                    {renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "hr":
      return <hr key={key} />;
  }
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="md-body">
      {parseBlocks(source).map((block, index) => renderBlock(block, `b${index}`))}
    </div>
  );
}
