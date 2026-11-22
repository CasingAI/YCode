import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

// 宽屏保留供应商的侧向子菜单和原有宽度规则。
// 窄屏使用同一面板内的逐级导航，由浏览器回归验证。

function readSource(): string {
  return read("../src/ModelConfigSelect.tsx");
}

function readSubmenuClassNameBody(): string {
  const source = readSource();
  const start = source.indexOf("function getProviderSubmenuContentClassName");
  assert.ok(start >= 0, "ModelConfigSelect 缺少 getProviderSubmenuContentClassName");
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, "无法定位 getProviderSubmenuContentClassName 函数体");
  return source.slice(start, end);
}

test("子菜单宽度使用固定下限与视口上限，不再引用 available-width", () => {
  const body = readSubmenuClassNameBody();
  assert.match(body, /w-max/, "子菜单必须按内容扩展（w-max）");
  assert.match(body, /min-w-\[12rem\]/, "子菜单必须有固定下限 min-w-[12rem]");
  assert.match(
    body,
    /max-w-\[calc\(100vw-2rem\)\]/,
    "子菜单必须有视口上限 max-w-[calc(100vw-2rem)]",
  );
  assert.doesNotMatch(
    body,
    /available-width/,
    "子菜单宽度不得再引用 --radix-dropdown-menu-content-available-width（窄屏会塌缩）",
  );
});

test("所有 DropdownMenuSubContent 都带 collisionPadding={8}", () => {
  const source = readSource();
  const tags = source.match(/<DropdownMenuSubContent\b[\s\S]*?>/g) ?? [];
  assert.ok(
    tags.length >= 3,
    `应至少有三处子菜单（其他二层、其他三层、普通二级），实际 ${tags.length}`,
  );
  for (const tag of tags) {
    assert.match(tag, /collisionPadding=\{8\}/, `子菜单缺少 collisionPadding={8}：\n${tag}`);
  }
});
