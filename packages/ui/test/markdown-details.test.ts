import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MarkdownDetails,
  MarkdownSummary,
} from "../src/components/ai-elements/markdown-details.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

function render(children: ReactNode, detailsProps?: { open?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(MarkdownDetails, { ...detailsProps }, children),
    ),
  );
}

test("折叠卡默认收起，summary 提取为卡片标题", () => {
  const markup = render([
    createElement(MarkdownSummary, { key: "summary" }, "构建结果（12 个文件）"),
    "\n",
    "正文内容",
  ]);

  assert.ok(markup.includes('aria-expanded="false"'), "默认折叠");
  assert.ok(markup.includes("构建结果（12 个文件）"), "summary 文本进卡片头部");
  assert.ok(markup.includes("正文内容"), "正文仍随卡片挂载（grid-rows 收起）");
});

test("显式 open 属性作为初始展开状态", () => {
  const markup = render(
    [
      createElement(MarkdownSummary, { key: "summary" }, "标题"),
      createElement("p", { key: "body" }, "正文"),
    ],
    { open: true },
  );

  assert.ok(markup.includes('aria-expanded="true"'));
});

test("流式 chunk 序列下卡片始终渲染：无 summary 时出兜底标题", () => {
  // chunk1: 仅 <details> 开标签（rehype-raw 自动补闭合后的形态）
  const chunk1 = render([]);
  assert.ok(chunk1.includes("aria-expanded"), "开标签到达即出卡片");
  assert.ok(chunk1.includes("详情"), "summary 未到达时显示兜底标题");

  // chunk2: <summary> 半截文本
  const chunk2 = render([createElement(MarkdownSummary, { key: "summary" }, "构建结果（12")]);
  assert.ok(chunk2.includes("构建结果（12"), "summary 流式填充");
  assert.ok(!chunk2.includes("详情</span>"), "兜底标题被替换");
});

test("无 summary 或畸形结构时正文不丢失", () => {
  const markup = render(["没有 summary 的裸内容"]);
  assert.ok(markup.includes("没有 summary 的裸内容"));
  assert.ok(markup.includes("详情"), "兜底标题");
});

test("嵌套 details 各自独立渲染折叠卡", () => {
  const markup = render([
    createElement(MarkdownSummary, {}, "外层"),
    createElement(MarkdownDetails, { key: "inner" }, [
      createElement(MarkdownSummary, { key: "inner-summary" }, "内层"),
      createElement("p", { key: "inner-body" }, "最内层内容"),
    ]),
  ]);

  assert.equal(markup.split('aria-expanded="false"').length - 1, 2, "两层折叠卡各自渲染");
  assert.ok(markup.includes("外层"));
  assert.ok(markup.includes("内层"));
  assert.ok(markup.includes("最内层内容"));
});
