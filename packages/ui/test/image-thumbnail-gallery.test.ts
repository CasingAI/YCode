import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageThumbnailGallery } from "../src/components/ai-elements/image-thumbnail-gallery.js";
import { ScrollFadeViewport } from "../src/components/ui/scroll-fade-viewport.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

function thumbnail(index: number) {
  return createElement(
    "button",
    { "data-image-thumbnail-trigger": "", key: index },
    createElement("img", { alt: `截图 ${index + 1}`, src: `shot-${index}.png` }),
  );
}

function renderGallery(children: ReactNode, grouped = true, props = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ImageThumbnailGallery, { grouped, ...props }, children),
    ),
  );
}

test("横滑图集：保留分组标记、吸附布局与张数角标", () => {
  const markup = renderGallery([thumbnail(0), "\n", thumbnail(1), "\n", thumbnail(2)], true, {
    "data-markdown-image-gallery": "",
  });

  assert.ok(markup.includes('data-markdown-image-gallery=""'), "灯箱分组依赖该标记");
  assert.ok(markup.includes("snap-x snap-mandatory"), "容器横向吸附");
  assert.ok(markup.includes("snap-start"), "子项吸附行首");
  assert.ok(markup.includes("3 张"), "角标只统计有效子项");
});

test("初始滚动位置在两端时箭头均禁用", () => {
  const markup = renderGallery([thumbnail(0), thumbnail(1)]);

  assert.equal(markup.split("disabled").length - 1 >= 2, true, "两端箭头初始禁用");
});

test("单图（grouped=false）保持 contents 透传布局", () => {
  const markup = renderGallery([thumbnail(0)], false);

  assert.ok(markup.includes('class="contents"'), "单图不做图集包裹");
  assert.ok(!markup.includes("snap-x"), "单图无横滑容器");
});

test("ScrollFadeViewport 默认垂直行为不变，横向为 flex 行", () => {
  const vertical = renderToStaticMarkup(createElement(ScrollFadeViewport, {}, "内容"));
  assert.ok(vertical.includes("overflow-y-auto"));
  assert.ok(!vertical.includes("w-max"), "垂直内容行不强制 flex");

  const horizontal = renderToStaticMarkup(
    createElement(ScrollFadeViewport, { orientation: "horizontal" }, "内容"),
  );
  assert.ok(horizontal.includes("overflow-x-auto"));
  assert.ok(horizontal.includes("flex w-max"), "横向内容行为 flex 行");
  assert.ok(horizontal.includes('data-scroll-mask="none"'));
});
