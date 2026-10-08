import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskGroupTag } from "../src/workspace-grouped-tasks/task-group-tag.js";

/**
 * TaskGroupTag 组件：无组不渲染由调用方保证（groupTag 缺省即不挂载）；
 * 这里覆盖图标切换、标题截断属性与颜色类透传，以及 compact 圆形形态。
 */

function render(
  group: Parameters<typeof TaskGroupTag>[0]["group"],
  compact?: boolean,
): string {
  return renderToStaticMarkup(createElement(TaskGroupTag, { group, compact }));
}

test("有 emoji 显示 emoji，无 emoji 显示标题首字", () => {
  const withEmoji = render({ id: "g1", title: "分组一", color: "blue", emoji: "🚀" });
  assert.match(withEmoji, /🚀/);
  assert.match(withEmoji, /分组一/);

  const withoutEmoji = render({ id: "g1", title: "分组一", color: "blue" });
  assert.match(withoutEmoji, /分/);
  assert.match(withoutEmoji, /分组一/);
});

test("title 属性保留组全名，data 属性带组 id", () => {
  const markup = render({ id: "g-42", title: "很长的分组标题", color: "red", emoji: "🎯" });
  assert.match(markup, /data-task-group-tag="g-42"/);
  assert.match(markup, /title="🎯 很长的分组标题"/);
});

test("坍缩语义：图标段永不压缩，文本段可截断", () => {
  // 纯 CSS 坍缩：外层 max-w 收窄时文本段 truncate 先被挤掉，图标段 shrink-0 保留。
  // 极窄只剩图标（emoji 或首字＋颜色背景）。此处断言 class 链存在。
  const markup = render({ id: "g1", title: "分组一", color: "blue", emoji: "🚀" });
  assert.match(markup, /max-w-36/);
  assert.match(markup, /shrink-0/);
  assert.match(markup, /truncate/);
});

test("颜色类随组颜色透传", () => {
  const blue = render({ id: "g1", title: "组", color: "blue" });
  assert.match(blue, /bg-sky-300/);
  const red = render({ id: "g1", title: "组", color: "red" });
  assert.match(red, /bg-rose-300/);
});

test("compact 紧凑态：圆形、只渲染图标段、无文本段", () => {
  // 置顶行与单行行用紧凑态：圆形（26px 方形）＋只渲染图标（emoji 或首字）＋组颜色背景。
  // 注：Badge 基类自带 rounded-full，紧凑与完整的区分断言用 size-[26px]（紧凑）/ max-w-36（完整）。
  // hover 语义保留：title/aria-label 仍是全名。
  const compactWithEmoji = render(
    { id: "g-7", title: "分组七", color: "blue", emoji: "🚀" },
    true,
  );
  assert.match(compactWithEmoji, /size-\[26px\]/);
  assert.match(compactWithEmoji, /🚀/);
  assert.match(compactWithEmoji, /bg-sky-300/);
  assert.match(compactWithEmoji, /title="🚀 分组七"/);
  assert.doesNotMatch(compactWithEmoji, /max-w-36/);
  assert.doesNotMatch(compactWithEmoji, /truncate/);
  // 文本段只渲染图标：组标题在文本节点里不得重复出现（只会在 title/aria 上出现）。
  assert.doesNotMatch(compactWithEmoji, />分组七</);

  const compactWithoutEmoji = render({ id: "g-7", title: "分组七", color: "red" }, true);
  assert.match(compactWithoutEmoji, /size-\[26px\]/);
  assert.match(compactWithoutEmoji, />分</);
  assert.match(compactWithoutEmoji, /bg-rose-300/);
  assert.match(compactWithoutEmoji, /title="分组七"/);
  assert.doesNotMatch(compactWithoutEmoji, />分组七</);
});

test("缺省仍是完整 pill 态（compact 未传）", () => {
  const markup = render({ id: "g1", title: "分组一", color: "blue", emoji: "🚀" });
  assert.doesNotMatch(markup, /size-\[26px\]/);
  assert.match(markup, /max-w-36/);
  assert.match(markup, /truncate/);
});

test("compact 位移：圆补行盒偏下，emoji span 补 ink 下偏，各 1px", () => {
  // 圆上的 -translate-y-px：父级标题行盒 h-6（24px），26px 圆实测渲染偏下（用户拍板）。
  // span 上的 -translate-y-px：emoji ink 中心比 line box 中心低 1px（位图字形 ascent 大
  // 于 descent），圆居中 line box，补这 1px 才是 ink 视觉居中。
  const withEmoji = render({ id: "g1", title: "组", color: "blue", emoji: "🚀" }, true);
  assert.equal(withEmoji.match(/-translate-y-px/g)?.length, 2);
});

test("圆内 emoji 字号 16px：22px 的 ink 25×26px 会把 26px 圆填满压边", () => {
  // 实测（DPR1/DPR2 一致）：Apple Color Emoji 22px 字号 ink 25×26px ＝ 圆内径 → 零边距；
  // 16px 字号 ink 22×22px，四周留 2px。
  const withEmoji = render({ id: "g1", title: "组", color: "blue", emoji: "🚀" }, true);
  assert.match(withEmoji, /text-\[16px\]/);
  assert.doesNotMatch(withEmoji, /text-\[22px\]/);
});

test("pill 完整态的图标段字号 15px：emoji 位图字形不再继承 text-ui-xs 的 11px", () => {
  const markup = render({ id: "g1", title: "组", color: "blue", emoji: "🚀" });
  assert.match(markup, /text-\[15px\]/);
});
