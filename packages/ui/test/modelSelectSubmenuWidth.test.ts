import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

// 子菜单窄屏呈现（docs/specs/provider-primary.md「子菜单窄屏呈现」）：
// 供应商子菜单（含「其他」第二、三层）宽度必须与主菜单同规则：
// w-max + 固定下限 min-w-[12rem] + 视口上限 max-w-[calc(100vw-2rem)]。
// 不能用 --radix-dropdown-menu-content-available-width 做 min/max：窄屏翻转后该变量
// 极小，会与 overflow-x-hidden、条目名 truncate 叠加，把模型名截成首字母。

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
  assert.ok(tags.length >= 3, `应至少有三处子菜单（其他二层、其他三层、普通二级），实际 ${tags.length}`);
  for (const tag of tags) {
    assert.match(
      tag,
      /collisionPadding=\{8\}/,
      `子菜单缺少 collisionPadding={8}：\n${tag}`,
    );
  }
});
