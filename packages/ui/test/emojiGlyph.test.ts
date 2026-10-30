import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmojiGlyph } from "../src/workspace-grouped-tasks/emoji-glyph.js";

/**
 * EmojiGlyph 的唯一可见字形契约：本地图片、固定尺寸、懒载，未知字符或加载
 * 失败只显示同尺寸中性图标，绝不把 emoji 字符作为文本回退。
 */

function render(emoji: string, size = 16): string {
  return renderToStaticMarkup(createElement(EmojiGlyph, { emoji, size }));
}

test("已知 emoji 渲染本地 Noto 图片，带固定尺寸与懒载属性", () => {
  const markup = render("🚀", 16);
  assert.match(markup, /<img /);
  assert.match(markup, /src="\.\/noto-emoji\/emoji_u1f680\.png"/);
  assert.match(markup, /width="16"/);
  assert.match(markup, /height="16"/);
  assert.match(markup, /style="width:16px;height:16px"/);
  assert.match(markup, /loading="lazy"/);
  assert.match(markup, /decoding="async"/);
  assert.match(markup, /draggable="false"/);
  assert.match(markup, /alt=""/);
  assert.match(markup, /aria-hidden="true"/);
  assert.doesNotMatch(markup, />🚀</, "不得把原 emoji 字符作为文本节点输出");
});

test("未知历史字符只渲染同尺寸中性图标，不输出原字符", () => {
  const markup = render("A", 16);
  assert.match(markup, /<svg/);
  assert.match(markup, /style="width:16px;height:16px"/);
  assert.doesNotMatch(markup, /<img /);
  assert.doesNotMatch(markup, />A</, "未知字符不得作为文本回退");
  assert.doesNotMatch(markup, /noto-emoji/);
});

test("切换 emoji 时图片源随字符变化，未知字符不保留旧图片", () => {
  const rocket = render("🚀", 16);
  const target = render("🎯", 16);
  const unknown = render("A", 16);

  assert.match(rocket, /emoji_u1f680\.png/);
  assert.match(target, /emoji_u1f3af\.png/);
  assert.notEqual(rocket, target);
  assert.doesNotMatch(unknown, /emoji_u1f680\.png/);
  assert.doesNotMatch(unknown, /emoji_u1f3af\.png/);
});

test("图片失败态按 URL 重新挂载，切换后不沿用旧失败状态", () => {
  const source = readFileSync(
    new URL("../src/workspace-grouped-tasks/emoji-glyph.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(source, /key=\{url\}/, "URL 变化必须重新挂载失败态所在组件");
});

test("选择器与对话框用局部 min-w-0 和固定图片尺寸约束 286px 内容盒", () => {
  const panel = readFileSync(
    new URL("../src/workspace-grouped-tasks/emoji-picker-panel.tsx", import.meta.url),
    "utf8",
  );
  const dialog = readFileSync(
    new URL("../src/workspace-grouped-tasks/emoji-picker-dialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(panel, /flex h-72 w-full min-w-0 flex-col/);
  assert.match(panel, /min-h-0 min-w-0 flex-1/);
  assert.match(panel, /flex h-8 min-w-0 flex-1 items-center justify-center/);
  assert.match(panel, /<EmojiGlyph emoji=\{emoji\.emoji\} size=\{20\}/);
  assert.match(panel, /<EmojiGlyph emoji=\{emoji\.emoji\} size=\{18\}/);
  assert.match(dialog, /<DialogContent className="min-w-0 sm:max-w-xs">/);
});
