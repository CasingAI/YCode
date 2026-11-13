import assert from "node:assert/strict";
import test from "node:test";

import { main } from "./fixtures/composer-toolbar-fit/run.js";

/**
 * Composer 工具栏 fit 的独立生产态验证。
 *
 * 真实加载 `useComposerToolbarFit` 与真实 React 点击/DOM 布局；只启动测试自己的
 * Vite、静态服务与无头 Chromium。不连接、不注入、不关闭、不重启正在运行的 YCode。
 */
test(
  "独立浏览器验证 Composer 工具栏测量合并、观察重绑与写入抑制",
  { timeout: 300_000 },
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
    assert.deepEqual(result.consoleErrors, [], "页面不应出现 console.error");
  },
);
