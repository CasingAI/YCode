import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ToolLayout } from "../src/ToolCallBlocks/ToolLayout.js";
import { ToolStatusWord } from "../src/ToolCallBlocks/ToolStatusWord.js";
import { resolveFailureDetailPointerAction } from "../src/ToolCallBlocks/toolStatusWordInteraction.js";

const STATUS_LABEL = "执行失败";
const FAILURE_DETAIL = "命令退出码 1：目标文件不存在";

const componentPath = fileURLToPath(
  new URL("../src/ToolCallBlocks/ToolStatusWord.tsx", import.meta.url),
);
const toolLayoutPath = fileURLToPath(
  new URL("../src/ToolCallBlocks/ToolLayout.tsx", import.meta.url),
);

function renderStatusWord(props: { label: string; detail?: string }): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ToolStatusWord, props),
    ),
  );
}

function renderToolLayout(): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ToolLayout, {
        toolId: "tool-status-word-test",
        icon: null,
        kindLabel: "命令",
        primaryText: "git status",
        showStatusLabel: true,
        statusLabel: STATUS_LABEL,
        statusTooltip: FAILURE_DETAIL,
      }),
    ),
  );
}

/** 取出同名事件处理器自身的源码片段（到下一个同名处理器为止）。 */
function handlerSource(source: string, propName: string): string {
  const start = source.indexOf(`${propName}={(event) => {`);
  assert.notEqual(start, -1, `必须实现 ${propName} 处理器`);
  const next = source.indexOf(`${propName}={(event) => {`, start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("失败状态词渲染成气泡触发区，错误正文不占用摘要行", () => {
  const markup = renderStatusWord({ label: STATUS_LABEL, detail: FAILURE_DETAIL });

  assert.match(markup, /执行失败/);
  // 虚线下划线是失败详情触发区的既有视觉标识。
  assert.match(markup, /decoration-dotted/);
  assert.match(markup, /cursor-help/);
  // 气泡关闭时错误正文不进摘要行空间。
  assert.equal(markup.includes(FAILURE_DETAIL), false);
});

test("没有失败详情时状态词只渲染纯文字", () => {
  const markup = renderStatusWord({ label: "已执行" });

  assert.match(markup, /已执行/);
  assert.equal(markup.includes("decoration-dotted"), false);
});

test("工具行把失败详情挂在状态词上", () => {
  const markup = renderToolLayout();

  assert.match(markup, /执行失败/);
  assert.match(markup, /decoration-dotted/);
  assert.equal(markup.includes(FAILURE_DETAIL), false);
});

test("指针动作规则：触摸自己打开并保住气泡，其余指针交给 Radix", () => {
  assert.equal(resolveFailureDetailPointerAction("touch"), "open-and-keep");
  assert.equal(resolveFailureDetailPointerAction("mouse"), "leave-to-radix");
  assert.equal(resolveFailureDetailPointerAction("pen"), "leave-to-radix");
  assert.equal(resolveFailureDetailPointerAction(undefined), "leave-to-radix");
});

test("失败详情气泡受控，触摸点按自己打开并挡住 Radix 的关闭", () => {
  const source = readFileSync(componentPath, "utf8");

  // 气泡开关状态由组件自己持有：不受控的话触摸端永远打不开。
  assert.match(source, /open=\{open\}/);
  assert.match(source, /onOpenChange=\{setOpen\}/);

  const pointerDownHandler = handlerSource(source, "onPointerDown");
  assert.match(pointerDownHandler, /resolveFailureDetailPointerAction\(event\.pointerType\)/);
  assert.match(pointerDownHandler, /setOpen\(true\)/);

  const clickHandler = handlerSource(source, "onClick");
  assert.match(clickHandler, /resolveFailureDetailPointerAction\(lastPointerTypeRef\.current\)/);
  // Radix trigger 的 click 语义是「关闭气泡」，触摸路径必须放行这次 click。
  assert.match(clickHandler, /event\.preventDefault\(\)/);

  // 气泡仍可交互：内有复制按钮，正文长。
  assert.match(source, /<TooltipContent[^>]*interactive/);
});

test("失败详情气泡只有一个渲染点，ToolLayout 不再自带 tooltip", () => {
  const toolLayoutSource = readFileSync(toolLayoutPath, "utf8");

  assert.match(
    toolLayoutSource,
    /<ToolStatusWord label=\{statusLabel\} detail=\{statusTooltip\} \/>/,
  );
  assert.doesNotMatch(toolLayoutSource, /components\/ui\/tooltip\.js/);
  assert.doesNotMatch(toolLayoutSource, /TooltipTrigger/);
});
