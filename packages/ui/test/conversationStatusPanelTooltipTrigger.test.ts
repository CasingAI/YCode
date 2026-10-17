import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const uiSourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

function collectTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

// ui 包没有 DOM 组件渲染基建；按现有源码断言测试约定，扫描所有调用点锁住 Popper ref 的分锚点接线。
test("Tooltip 包裹 DropdownMenuTrigger 时使用独立 DOM 锚点", () => {
  const affectedFiles = new Set<string>();

  for (const path of collectTsxFiles(uiSourceRoot)) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /<ControlHintTooltip\b[^>]*>([\s\S]*?)<\/ControlHintTooltip>/g,
    )) {
      const tooltipBlock = match[1];
      if (!tooltipBlock.includes("<DropdownMenuTrigger")) continue;

      affectedFiles.add(path);
      assert.match(
        tooltipBlock,
        /^\s*<span className="inline-flex">/,
        `${path} 必须让 Tooltip 锚定独立 span`,
      );
      assert.doesNotMatch(tooltipBlock, /<span[^>]*tabIndex=/, `${path} 不得新增焦点位`);
    }
  }

  assert.ok(affectedFiles.size > 0, "必须扫描到状态面板的菜单 Tooltip 接线");
  assert.ok(
    [...affectedFiles].some((path) => path.endsWith("/v4/ConversationStatusPanel.tsx")),
    "状态面板的菜单 Tooltip 必须保留",
  );
});
