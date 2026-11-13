import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSidePaneTabsMaskEdges,
  resolveSidePaneTabsOverflow,
} from "../src/app-shell/sidePaneLayout.js";

// 侧栏溢出判定沿用稳定最小宽度预算：每个 tab 60px、间距 4px、容差 1px。
// 这些用例锁住临界值与 60px 下限，避免后续把预算改成实测 scrollWidth 后重新引入
// “overflow 状态移动新增按钮 → 宽度变化 → 再次判 overflow”的反馈环。

test("溢出判定：60px 下限预算与 1px 容差临界值", () => {
  // 4 个 tab：4 * 60 + 3 * 4 = 252；新增按钮 28px，末尾再留 4px 间距。
  // 内容宽 284，视图宽 283 时 284 > 283 + 1 为 false，正好落在容差边界。
  const base = {
    addButtonWidth: 28,
    tabCount: 4,
    addButtonInside: true,
  };
  assert.equal(
    resolveSidePaneTabsOverflow({ ...base, viewportWidth: 283 }),
    false,
    "内容宽刚好等于视图宽 + 1px 容差时不算溢出",
  );
  assert.equal(
    resolveSidePaneTabsOverflow({ ...base, viewportWidth: 282 }),
    true,
    "内容宽比视图宽多 2px 时算溢出",
  );
});

test("溢出判定：新增按钮在内容外时补回同样宽度，判定结果不变", () => {
  // 真实布局里 overflow 会把新增按钮移出 viewport；viewport 因此少掉按钮宽度。
  // 判定必须还原“按钮仍在末尾”的假想宽度，否则临界区会来回翻转。
  const shared = {
    addButtonWidth: 28,
    tabCount: 4,
  };
  assert.equal(
    resolveSidePaneTabsOverflow({ ...shared, addButtonInside: true, viewportWidth: 282 }),
    true,
  );
  assert.equal(
    resolveSidePaneTabsOverflow({
      ...shared,
      addButtonInside: false,
      viewportWidth: 282 - 28,
    }),
    true,
  );
  assert.equal(
    resolveSidePaneTabsOverflow({ ...shared, addButtonInside: true, viewportWidth: 283 }),
    false,
  );
  assert.equal(
    resolveSidePaneTabsOverflow({
      ...shared,
      addButtonInside: false,
      viewportWidth: 283 - 28,
    }),
    false,
  );
});

test("溢出判定：必须使用 60px 最小宽度而不是实际标签宽度", () => {
  // 10 个 tab：10 * 60 + 9 * 4 = 636；加按钮与间距后内容宽 668。
  const params = {
    addButtonWidth: 28,
    addButtonInside: true,
    tabCount: 10,
  };
  assert.equal(resolveSidePaneTabsOverflow({ ...params, viewportWidth: 667 }), false);
  assert.equal(resolveSidePaneTabsOverflow({ ...params, viewportWidth: 666 }), true);
});

test("溢出判定：无标签时只有新增按钮参与预算", () => {
  const params = { addButtonWidth: 28, addButtonInside: true, tabCount: 0 };
  assert.equal(resolveSidePaneTabsOverflow({ ...params, viewportWidth: 28 }), false);
  assert.equal(resolveSidePaneTabsOverflow({ ...params, viewportWidth: 26 }), true);
});

test("溢出判定：新增按钮宽度未知为 0 时仍按容差判定", () => {
  const params = { addButtonWidth: 0, addButtonInside: true, tabCount: 4 };
  // 内容宽 = 252 + 4 + 0 = 256。
  assert.equal(resolveSidePaneTabsOverflow({ ...params, viewportWidth: 255 }), false);
  assert.equal(resolveSidePaneTabsOverflow({ ...params, viewportWidth: 254 }), true);
});

test("mask 派生：非溢出时两端都不显示", () => {
  assert.deepEqual(
    resolveSidePaneTabsMaskEdges({ isOverflowing: false, scrollLeft: 50, maxScrollLeft: 100 }),
    { left: false, right: false },
  );
});

test("mask 派生：用 1px 容差判定两端是否仍有可滚内容", () => {
  const resolve = (scrollLeft: number, maxScrollLeft = 100) =>
    resolveSidePaneTabsMaskEdges({ isOverflowing: true, scrollLeft, maxScrollLeft });

  assert.deepEqual(resolve(0), { left: false, right: true });
  assert.deepEqual(resolve(1), { left: false, right: true });
  assert.deepEqual(resolve(1.5), { left: true, right: true });
  assert.deepEqual(resolve(98.5), { left: true, right: true });
  assert.deepEqual(resolve(99), { left: true, right: false });
  assert.deepEqual(resolve(100), { left: true, right: false });
});

test("mask 派生：无可滚距离时不显示右端", () => {
  assert.deepEqual(
    resolveSidePaneTabsMaskEdges({ isOverflowing: true, scrollLeft: 0, maxScrollLeft: 0 }),
    { left: false, right: false },
  );
});
