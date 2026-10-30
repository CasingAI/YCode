import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskGroupColorMark } from "../src/workspace-grouped-tasks/colors.js";

/**
 * 分组头 emoji 的可见承载唯一化：emoji 只渲染在颜色圆里，标题前不再重复一份。
 * 回归来源：颜色圆改显示 emoji 后，标题前旧的行内 emoji 前缀没删，分组头同时出现
 * 一大一小两个火箭（用户截图指出）。
 */

const groupItemSource = readFileSync(
  new URL("../src/workspace-grouped-tasks/group-item.tsx", import.meta.url),
  "utf8",
);
const stickyHeaderSource = readFileSync(
  new URL("../src/workspace-grouped-tasks/sticky-group-header.tsx", import.meta.url),
  "utf8",
);

test("颜色圆：有 emoji 时圆内显示本地图片替代 Hash 图标", () => {
  const withEmoji = renderToStaticMarkup(
    createElement(TaskGroupColorMark, { color: "blue", emoji: "🚀" }),
  );
  assert.match(withEmoji, /<img /);
  assert.match(withEmoji, /emoji_u1f680\.png/);
  assert.match(withEmoji, /size-\[26px\]/);
  assert.doesNotMatch(withEmoji, /<svg/);
  assert.doesNotMatch(withEmoji, />🚀</);

  const withoutEmoji = renderToStaticMarkup(createElement(TaskGroupColorMark, { color: "blue" }));
  assert.match(withoutEmoji, /<svg/);
  assert.doesNotMatch(withoutEmoji, /<img /);
  assert.doesNotMatch(withoutEmoji, /🚀/);
});

test("颜色圆：图片固定 16px，不再使用字号或字形位移", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskGroupColorMark, { color: "blue", emoji: "🚀" }),
  );
  assert.match(markup, /style="width:16px;height:16px"/);
  assert.doesNotMatch(markup, /text-\[16px\]|text-\[22px\]/);
  assert.doesNotMatch(markup, /-translate-y-px/);
});

test("颜色圆：未知历史 emoji 显示同尺寸中性图标，不回退原字符", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskGroupColorMark, { color: "blue", emoji: "A" }),
  );
  assert.match(markup, /<svg/);
  assert.match(markup, /style="width:16px;height:16px"/);
  assert.doesNotMatch(markup, /<img /);
  assert.doesNotMatch(markup, />A</);
});

test("分组头与吸顶头：标题前不再渲染行内 emoji 前缀", () => {
  for (const [name, source] of [
    ["group-item.tsx", groupItemSource],
    ["sticky-group-header.tsx", stickyHeaderSource],
  ] as const) {
    // 行内 emoji 前缀曾是 <span aria-hidden="true" className="mr-1">{emoji}</span>，
    // 与颜色圆内的 emoji 重复；删除后标题节点只剩 displayTitle 文本。
    assert.doesNotMatch(source, /className="mr-1"/, `${name} 仍渲染行内 emoji 前缀`);
  }
});

test("分组头与吸顶头：两处菜单项都复用 EmojiGlyph，不再直接输出字符", () => {
  for (const [name, source] of [
    ["group-item.tsx", groupItemSource],
    ["sticky-group-header.tsx", stickyHeaderSource],
  ] as const) {
    assert.equal(
      source.match(/<EmojiGlyph emoji=\{node\.group\.emoji\}/g)?.length,
      2,
      `${name} 的 emoji 菜单项应全部经 EmojiGlyph 渲染`,
    );
    assert.doesNotMatch(source, /<span aria-hidden="true">\{node\.group\.emoji\}<\/span>/);
  }
});

test("分组头与吸顶头：title/aria 仍保留 emoji 前缀供悬浮提示与读屏", () => {
  assert.match(groupItemSource, /`\$\{node\.group\.emoji\} \$\{displayTitle\}`/);
  assert.match(stickyHeaderSource, /`\$\{node\.group\.emoji\} \$\{displayTitle\}`/);
});
