import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAboutSheetNativePath } from "../src/main/aboutSheetDismiss.js";
import {
  resolveAboutWindowAttachParent,
  resolveAboutWindowPosition,
  shouldUseAboutWindowModal,
} from "../src/main/about.js";

test("有父窗口时三端都挂接并做成 modal，macOS 才能走系统 sheet", () => {
  const parent = { id: "main" };
  assert.equal(resolveAboutWindowAttachParent(parent, "darwin"), parent);
  assert.equal(resolveAboutWindowAttachParent(parent, "win32"), parent);
  assert.equal(resolveAboutWindowAttachParent(parent, "linux"), parent);
  assert.equal(resolveAboutWindowAttachParent(undefined, "darwin"), undefined);
  assert.equal(shouldUseAboutWindowModal(true, "darwin"), true);
  assert.equal(shouldUseAboutWindowModal(true, "win32"), true);
  assert.equal(shouldUseAboutWindowModal(true, "linux"), true);
  assert.equal(shouldUseAboutWindowModal(false, "darwin"), false);
});

test("没有父窗口时不做成 modal", () => {
  assert.equal(shouldUseAboutWindowModal(false, "win32"), false);
  assert.equal(shouldUseAboutWindowModal(false, "linux"), false);
});

test("非 sheet 时关于面板相对父窗口内容区水平居中并贴顶", () => {
  assert.deepEqual(
    resolveAboutWindowPosition({ x: 100, y: 80, width: 800, height: 600 }, { width: 256, height: 320 }),
    { x: 372, y: 80 },
  );
});

test("打包态从 extraResources 加载 sheet 辅助模块，否则回退到仓库 resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-about-sheet-"));
  try {
    const packaged = join(dir, "macos-about-sheet");
    await mkdir(packaged);
    const nativePath = join(packaged, "about-sheet.node");
    await writeFile(nativePath, "");
    assert.equal(resolveAboutSheetNativePath("/unused/main", dir), nativePath);
    assert.equal(
      resolveAboutSheetNativePath("/fake/main", "/missing/resources"),
      join("/fake/main", "..", "..", "resources", "macos-about-sheet", "about-sheet.node"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
