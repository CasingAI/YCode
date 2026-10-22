import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MarkdownDetails,
  MarkdownSummary,
} from "../src/components/ai-elements/markdown-details.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR } from "../src/v4/timelineToggleAnchor.js";

function render(children: ReactNode, detailsProps?: { open?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(MarkdownDetails, { ...detailsProps }, children),
    ),
  );
}

// React 在属性值里把 & 和 > 转义成实体，比较 class 前先还原。
function decodeClassNames(markup: string): string[] {
  const regionTag = markup.match(/<div[^>]*role="region"[^>]*>/);
  assert.ok(regionTag, "折叠区正文容器存在");
  const classAttr = regionTag[0].match(/class="([^"]*)"/);
  assert.ok(classAttr, "正文容器带 class");
  return classAttr[1].replace(/&amp;/g, "&").replace(/&gt;/g, ">").split(/\s+/);
}

// 头部按钮里的箭头图标是第一个 svg，读取它的 class 用来判断朝向。
function chevronClasses(markup: string): string[] {
  const svgTag = markup.match(/<svg[^>]*>/);
  assert.ok(svgTag, "折叠卡头部有箭头图标");
  const classAttr = svgTag[0].match(/class="([^"]*)"/);
  assert.ok(classAttr, "箭头图标带 class");
  return classAttr[1].split(/\s+/);
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

test("折叠区正文容器自带块间距，段落不与顶层脱节", () => {
  const markup = render([
    createElement(MarkdownSummary, { key: "summary" }, "标题"),
    createElement("p", { key: "p1" }, "第一段"),
    createElement("p", { key: "p2" }, "第二段"),
  ]);

  const classes = decodeClassNames(markup);

  // 顶层段落间距来自 Streamdown 根容器的 space-y-4，段落 p 自身没有 margin，
  // 嵌套容器不显式提供间距时内部段落会紧贴。
  assert.ok(classes.includes("space-y-4"), "正文容器提供块间距");
  assert.ok(classes.includes("[&>*:first-child]:mt-0"), "首个子元素 margin 归零");
  assert.ok(classes.includes("[&>*:last-child]:mb-0"), "末个子元素 margin 归零");
});

test("折叠卡头部接入时间线折叠触发器槽位，展开时保持原位", () => {
  // 漏接槽位时，展开引起的高度变化会按「跟随即贴底」裁决，把卡片头部连续顶出视口
  // （表现为简介栏飘到屏幕外）。这里直接断言按钮带的时间线选择器能识别到的槽位。
  const markup = render([
    createElement(MarkdownSummary, { key: "summary" }, "两种修法的取舍"),
    createElement("p", { key: "body" }, "正文"),
  ]);

  const buttonTag = markup.match(/<button[^>]*>/);
  assert.ok(buttonTag, "卡片头部是 button");

  const slot = TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR.match(/data-slot='([^']+)'/)?.[1];
  assert.ok(slot, "时间线选择器声明了折叠触发器槽位");
  assert.ok(
    buttonTag[0].includes(`data-slot="${slot}"`),
    "折叠卡头部带时间线识别的折叠触发器槽位",
  );
  assert.ok(buttonTag[0].includes("scroll-mt-14"), "头部留出顶部安全区，避免被悬浮顶栏盖住");
});

test("箭头指向内容铺开的方向：收起朝右、展开朝下", () => {
  // 箭头方向是折叠卡与同屏其他折叠入口（文件变更摘要等）的统一语言：
  // 收起画 › 表示「点我展开」，展开画 ⌄ 表示内容已在下方铺开。
  const collapsed = render([createElement(MarkdownSummary, { key: "summary" }, "标题")]);
  const expanded = render([createElement(MarkdownSummary, { key: "summary" }, "标题")], {
    open: true,
  });

  const collapsedClasses = chevronClasses(collapsed);
  const expandedClasses = chevronClasses(expanded);

  assert.ok(
    collapsedClasses.includes("lucide-chevron-right"),
    "收起态用右箭头作为基础图形，不能用下箭头",
  );
  assert.ok(!collapsedClasses.includes("rotate-90"), "收起态不旋转，箭头朝右");
  assert.ok(expandedClasses.includes("lucide-chevron-right"), "展开态沿用同一个右箭头图形");
  assert.ok(expandedClasses.includes("rotate-90"), "展开态旋转 90 度，箭头朝下");
  assert.ok(!expandedClasses.includes("rotate-180"), "不再翻转成朝上的箭头");
});
