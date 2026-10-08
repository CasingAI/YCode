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

test("颜色圆：有 emoji 时圆内显示 emoji 替代 Hash 图标", () => {
  const withEmoji = renderToStaticMarkup(
    createElement(TaskGroupColorMark, { color: "blue", emoji: "🚀" }),
  );
  assert.match(withEmoji, /🚀/);
  assert.match(withEmoji, /size-\[26px\]/);
  assert.doesNotMatch(withEmoji, /<svg/);

  const withoutEmoji = renderToStaticMarkup(createElement(TaskGroupColorMark, { color: "blue" }));
  assert.match(withoutEmoji, /<svg/);
  assert.doesNotMatch(withoutEmoji, /🚀/);
});

test("颜色圆：emoji 字号 16px 且 span 上移 1px，不再用会填满 26px 圆的 22px", () => {
  // 22px 字号实测 ink 25×26px（＝圆内径）→ 用户截图里的「火箭超出圆盘」；
  // 16px 字号 ink 22×22px 留 2px 边距；该字号 ink 中心比 line box 低 1px，补 -1px。
  const markup = renderToStaticMarkup(
    createElement(TaskGroupColorMark, { color: "blue", emoji: "🚀" }),
  );
  assert.match(markup, /text-\[16px\]/);
  assert.match(markup, /-translate-y-px/);
  assert.doesNotMatch(markup, /text-\[22px\]/);
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

test("分组头与吸顶头：title/aria 仍保留 emoji 前缀供悬浮提示与读屏", () => {
  assert.match(groupItemSource, /`\$\{node\.group\.emoji\} \$\{displayTitle\}`/);
  assert.match(stickyHeaderSource, /`\$\{node\.group\.emoji\} \$\{displayTitle\}`/);
});
