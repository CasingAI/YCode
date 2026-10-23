import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("收起侧栏在共同外层禁用原生拖动，展开时不启用边界", async () => {
  const source = await readFile(
    new URL("../src/app-shell/WorkspaceShellLayout.tsx", import.meta.url),
    "utf8",
  );
  const panelStart = source.indexOf("ref={workspaceSidebarPanelElementRef}");
  const panelEnd = source.indexOf("ref={sidebarContainerRef}", panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  const panel = source.slice(panelStart, panelEnd);
  assert.match(panel, /id="sidebar"/);
  const boundary = '!isSidebarPanelVisible && "window-drag-disabled"';
  assert.ok(panel.includes(boundary), "只有侧栏隐藏时才应禁用其自身和全部后代的原生拖动");
  assert.equal((panel.match(/window-drag-disabled/g) ?? []).length, 1);
  assert.ok(
    panel.indexOf(boundary) < panel.indexOf('sidebarPresentation === "drawer"'),
    "禁拖边界必须位于两种形态共享的外层，覆盖透明inline和离屏drawer",
  );
});
