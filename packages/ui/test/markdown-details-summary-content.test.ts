import assert from "node:assert/strict";
import test from "node:test";
// summary 内容归位回归测试：走真实 MessageResponse 管线（remark→rehype-raw→
// 归位插件→sanitize/harden→Streamdown→a 渲染器）SSR，锁住「<summary> 漏写闭合
// 标签导致表格被吞进折叠卡标题」这条渲染缺陷。
// 原文取自真实会话 part_mvixmdv7_d7d149cd-2e09-4b9a-bd3f-6bbbfb2fa5a5。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../src/components/ai-elements/message.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { detailsSummaryContentRehypePlugin } from "../src/lib/detailsSummaryContentRehypePlugin.js";

// 真实会话里的畸形原文：<summary> 没有闭合标签，表格跟在后面。
const malformedDetails = [
  "<details>",
  "<summary>相关代码与数据位置",
  "",
  "| 关注点 | 位置 |",
  "|---|---|",
  '| yield 文本生成（含 "full transcript are preserved"） | `apps/zcode-cli/packages/core/src/tool/handlers/subagent-yield-output.ts:3-14` |',
  "| HistoryRead 只取 text part，过滤掉 reasoning/tool | `apps/zcode-cli/packages/contracts/src/tools/history-projection.ts:70-88` |",
  "| 该次打断的模型输入存档 | `~/.zcode/cli/debug/model-io-sess_59469d64.jsonl` record 2/3 |",
  "",
  "</details>",
].join("\n");

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(MessageResponse, { streaming: false }, markdown),
      ),
    ),
  );
}

/** 折叠卡头部按钮（data-slot="collapsible-trigger"）的内部 HTML。 */
function headerButtonHtml(markup: string): string {
  const start = markup.indexOf('data-slot="collapsible-trigger"');
  assert.ok(start > 0, `渲染结果里没有折叠卡头部:\n${markup}`);
  const end = markup.indexOf("</button>", start);
  assert.ok(end > start, `折叠卡头部没有闭合:\n${markup}`);
  return markup.slice(start, end);
}

test("summary 漏写闭合标签时表格落在折叠正文区，不进卡片标题", () => {
  const markup = renderMarkdown(malformedDetails);
  const header = headerButtonHtml(markup);

  assert.ok(!header.includes("<table"), `表格不应出现在折叠卡标题按钮里:\n${header}`);
  assert.ok(header.includes("相关代码与数据位置"), `标题按钮应保留 summary 文本:\n${header}`);

  const regionIndex = markup.indexOf('role="region"');
  assert.ok(regionIndex > 0, `渲染结果里没有折叠正文区:\n${markup}`);
  assert.ok(markup.indexOf("<table", regionIndex) > 0, `表格应落在折叠正文区:\n${markup}`);
});

test("归位后表格保留全部行与两列，不丢内容", () => {
  const markup = renderMarkdown(malformedDetails);

  assert.equal(markup.match(/<th[\s>]/g)?.length, 2, `表头应有两列:\n${markup}`);
  assert.equal(markup.match(/<tr[\s>]/g)?.length, 4, `应有表头行加三行数据:\n${markup}`);
  assert.ok(markup.includes("关注点"), `应保留第一列表头:\n${markup}`);
  assert.ok(markup.includes("该次打断的模型输入存档"), `末行不应丢失:\n${markup}`);
  assert.ok(markup.includes("history-projection.ts:70-88"), `末列内容不应丢失:\n${markup}`);
});

test("合法的 summary 闭合结构不受影响", () => {
  const markup = renderMarkdown(
    [
      "<details>",
      "<summary>相关代码与数据位置</summary>",
      "",
      "| 关注点 | 位置 |",
      "|---|---|",
      "| A | B |",
      "",
      "</details>",
    ].join("\n"),
  );
  const header = headerButtonHtml(markup);

  assert.ok(!header.includes("<table"), `合法结构下表格也不该进标题:\n${header}`);
  assert.ok(header.includes("相关代码与数据位置"), `标题文本应保留:\n${header}`);
  const regionIndex = markup.indexOf('role="region"');
  assert.ok(markup.indexOf("<table", regionIndex) > 0, `表格应落在折叠正文区:\n${markup}`);
});

test("summary 里的 heading 属于合法标题内容，不被搬走", () => {
  const markup = renderMarkdown(
    [
      "<details>",
      "<summary><h3>相关代码与数据位置</h3></summary>",
      "",
      "| 关注点 |",
      "|---|",
      "| A |",
      "",
      "</details>",
    ].join("\n"),
  );
  const header = headerButtonHtml(markup);

  assert.ok(header.includes("<h3"), `heading 应留在标题里:\n${header}`);
  assert.ok(!header.includes("<table"), `表格不应进标题:\n${header}`);
});

test("summary 归位后没有标题文本时走头部兜底文案", () => {
  const markup = renderMarkdown(
    ["<details>", "<summary>", "", "| 关注点 |", "|---|", "| A |", "", "</details>"].join("\n"),
  );
  const header = headerButtonHtml(markup);

  assert.ok(header.includes("详情"), `空标题应回退到兜底文案:\n${header}`);
  assert.ok(!header.includes("<table"), `表格不应进标题:\n${header}`);
});

test("插件把 summary 下的块级内容搬到 details 内、紧跟 summary 之后", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "details",
        children: [
          {
            type: "element",
            tagName: "summary",
            children: [
              { type: "text", value: "标题" },
              { type: "element", tagName: "table", children: [] },
            ],
          },
        ],
      },
    ],
  };

  const transformer = (
    detailsSummaryContentRehypePlugin as unknown as () => (tree: unknown) => void
  )();
  transformer(tree);

  const details = tree.children[0]!;
  const summary = details.children![0]!;
  const table = details.children![1]!;

  assert.equal(summary.type === "element" && summary.tagName, "summary");
  assert.equal(summary.children?.length, 1, "summary 只应保留标题文本");
  assert.equal(table.type === "element" && table.tagName, "table");
  assert.equal(details.children?.length, 2, "表格应作为 summary 的下一个兄弟节点");
});
