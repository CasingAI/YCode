import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../src/components/ai-elements/message.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

const LONG_WINDOWS_PATH =
  "C:\\Users\\MPC\\Documents\\ExportedProject\\Assets\\Resource\\Shader\\CharacterOutlinePostProcess\\CharacterOutlinePostProcessPass.hlsl";

function renderResponse(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(MessageResponse, null, markdown),
    ),
  );
}

// React 在属性值里把 & 和 > 转义成实体，比较 class 前先还原。
function classNamesOf(tag: string): string[] {
  const classAttr = tag.match(/class="([^"]*)"/);
  assert.ok(classAttr, "标签带 class");
  return classAttr[1].replace(/&amp;/g, "&").replace(/&gt;/g, ">").split(/\s+/);
}

test("助手正文根容器带 break-words，长 Windows 路径可换行", () => {
  const markup = renderResponse(`导出的文件位于 ${LONG_WINDOWS_PATH}`);

  const rootTag = markup.match(/<div class="[^"]*"/);
  assert.ok(rootTag, "正文根容器存在");
  const rootClasses = classNamesOf(rootTag[0]);

  assert.ok(rootClasses.includes("break-words"), "根容器声明 overflow-wrap: break-word");
  assert.ok(markup.includes(LONG_WINDOWS_PATH), "长路径按原文进入正文");
});

test("行内代码中的长路径不被阻止换行", () => {
  const markup = renderResponse(`详见 \`${LONG_WINDOWS_PATH}\``);

  const inlineCodeTag = markup.match(/<code[^>]*>/);
  assert.ok(inlineCodeTag, "行内 code 元素存在");
  const inlineCodeClasses = classNamesOf(inlineCodeTag[0]);

  assert.ok(
    !inlineCodeClasses.includes("whitespace-nowrap"),
    "行内 code 不得声明 whitespace-nowrap 之类的阻止换行样式",
  );
  assert.ok(
    !inlineCodeClasses.includes("whitespace-pre"),
    "行内 code 不得声明保留原始空白的换行样式",
  );
  assert.ok(markup.includes(LONG_WINDOWS_PATH), "行内代码保留长路径原文");
});

test("普通中文与短文本仍按既有规则渲染", () => {
  const markup = renderResponse("这是一段普通的中文正文，用于确认换行规则未被改变。");

  assert.ok(markup.includes("这是一段普通的中文正文"), "中文正文正常渲染");
  const rootTag = markup.match(/<div class="[^"]*"/);
  assert.ok(rootTag, "正文根容器存在");
  assert.ok(classNamesOf(rootTag[0]).includes("break-words"), "断行规则仍在根容器");
});
