import assert from "node:assert/strict";
import test from "node:test";

import { main } from "./fixtures/files-full-text-editor/run.mjs";

/**
 * 9.7 MiB / 约 40 万行合法 JSON 在完整正文编辑器中的隔离交互回归。
 *
 * 独立 Vite 构建 + 独立无头 Chromium，挂载真实 FilesEditorGroupPane、
 * FilesEditorStore 与真实 Monaco（monaco-editor），只替换服务/宿主边界。
 * 断言完整 model 与行号、跨旧 262140 块和旧 8 MiB 的全文搜索、Ctrl+End、
 * 跨旧块编辑 + 撤销重做、保存后重开完整内容，以及 IndexedDB 大草稿恢复。
 *
 * 不连接、不操作正在运行的 YCode；不下载浏览器或依赖。
 */
test(
  "完整正文编辑器真实浏览器回归：9.7 MiB JSON 不切块",
  { timeout: 600_000 },
  async (t) => {
    const result = await main();
    if (result.skipped) {
      t.skip(result.skipReason);
      return;
    }
    for (const assertion of result.assertions) {
      assert.ok(assertion.ok, `${assertion.name}: ${JSON.stringify(assertion.detail)}`);
    }
    assert.deepEqual(result.pageErrors, [], "页面不应出现 pageerror");
    console.log(`完整正文编辑器断言: ${result.assertions.length}/${result.assertions.length} 通过`);
    console.log(`完整正文编辑器交互证据截图: ${result.screenshots.join(", ")}`);
  },
);
