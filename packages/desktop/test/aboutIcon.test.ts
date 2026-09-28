import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIconDataUrl } from "../src/main/about.js";
import { createCustomAboutDialogHtml } from "../src/main/aboutWindow.js";

// 只取 PNG 文件头，够验证"读到的字节原样进了 data URL"，不引入图片解码依赖。
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const BASE_INPUT = {
  applicationName: "YCode Desktop App",
  appVersion: "3.14.21",
  copyright: "版权所有 © 2026 YCode。",
  optimizationLine: "已针对 Apple Silicon 优化。",
  versionLabel: "版本",
  okButtonLabel: "确定",
};

test("createIconDataUrl 把图标文件读成可回解的 PNG data URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-about-icon-"));
  const iconPath = join(dir, "icon.png");
  try {
    await writeFile(iconPath, PNG_SIGNATURE);
    const dataUrl = createIconDataUrl(iconPath);
    assert.ok(dataUrl.startsWith("data:image/png;base64,"), `实际为 ${dataUrl.slice(0, 32)}`);
    const encoded = dataUrl.slice("data:image/png;base64,".length);
    assert.deepEqual(Buffer.from(encoded, "base64"), PNG_SIGNATURE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createIconDataUrl 在文件不存在时返回空串而不是抛错", () => {
  assert.equal(createIconDataUrl(join(tmpdir(), "zcode-about-icon-not-exist.png")), "");
});

test("关于面板渲染调用方传入的图标 data URL", () => {
  const iconDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const html = createCustomAboutDialogHtml({ ...BASE_INPUT, iconDataUrl });
  assert.ok(html.includes(`src="${iconDataUrl}"`), "产物应包含传入的图标 src");
  assert.ok(html.includes('class="app-icon"'), "产物应包含图标容器");
});

test("关于面板不再内联旧的品牌标识 SVG", () => {
  const html = createCustomAboutDialogHtml({
    ...BASE_INPUT,
    iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  });
  assert.equal(html.includes("<svg"), false, "不应残留内联 SVG");
  assert.equal(html.includes("M134.4"), false, "不应残留旧标识的 path 数据");
  assert.equal(html.includes("currentColor"), false, "不应残留旧标识的描边色写法");
});

test("图标为空串时整块省略，且不影响其余内容渲染", () => {
  const html = createCustomAboutDialogHtml({ ...BASE_INPUT, iconDataUrl: "" });
  assert.equal(html.includes("<img"), false, "不应输出 img 标签");
  assert.equal(html.includes('class="app-icon"'), false, "不应输出图标容器");
  assert.ok(html.includes("YCode Desktop App"), "标题仍应渲染");
  assert.ok(html.includes("3.14.21"), "版本行仍应渲染");
  assert.ok(html.includes("已针对 Apple Silicon 优化。"), "优化行仍应渲染");
  assert.ok(html.includes("确定"), "按钮文案仍应渲染");
});
