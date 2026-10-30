import assert from "node:assert/strict";
import test from "node:test";

import { main } from "./fixtures/files-editor-markdown-preview/run.mjs";

/**
 * 文件编辑器标签条的 Markdown 源码/预览切换隔离交互验证。
 *
 * 独立 Vite 构建 + 独立无头 Chromium，挂载真实 FilesEditorGroupPane 与真实
 * filesEditorStore；只 stub 服务边界。不连接、不操作正在运行的 YCode。
 * 详细边界与降级说明见 fixtures/files-editor-markdown-preview/README.md。
 */
test("独立浏览器验证 Markdown 源码/预览按视图切换", { timeout: 300_000 }, async (t) => {
  const result = await main();
  if (result.skipped) {
    t.skip(result.skipReason);
    return;
  }
  for (const assertion of result.assertions) {
    assert.ok(assertion.ok, `${assertion.name}: ${JSON.stringify(assertion.detail)}`);
  }
  assert.deepEqual(result.pageErrors, [], "页面不应出现 pageerror");
  console.log(`Markdown 模式交互证据截图: ${result.screenshots.join(", ")}`);
});
