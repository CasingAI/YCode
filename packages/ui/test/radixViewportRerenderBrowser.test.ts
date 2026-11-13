import assert from "node:assert/strict";
import test from "node:test";

import { main } from "./fixtures/radix-viewport-rerender/run.js";

/**
 * Radix Select / ScrollArea Viewport 固定样式重复写入的独立生产态验证。
 *
 * 使用 node_modules 中真实 Radix 包的 ESM 与 CJS 构建；只启动测试自己的 Vite、
 * 静态服务与无头 Chromium。不连接、不操作正在运行的 YCode。
 */
test(
  "独立浏览器验证 Radix Viewport 固定样式在强制重渲染下零额外写入",
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
  },
);
