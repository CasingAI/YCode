import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// 「其他」组的三级结构（docs/specs/provider-primary.md）：
// 一级 = 主菜单里的「其他」标题；二级 = 「其他」下的供应商子菜单；三级 = 模型。
// ModelConfigSelect 的菜单面板走 Radix Portal，SSR 静态渲染拿不到面板内容，
// 因此这里按仓库既有做法断言渲染源码的分支结构。

function readOtherBranch(): { source: string; branch: string } {
  const source = read("../src/ModelConfigSelect.tsx");
  const start = source.indexOf("if (group.isOtherGroup) {");
  const end = source.indexOf("if (group.directItems) {");
  assert.ok(start >= 0 && end > start, "ModelConfigSelect 缺少 isOtherGroup 分支或分支顺序不对");
  return { source, branch: source.slice(start, end) };
}

test("「其他」组有独立渲染分支，且排在普通分组分支之前", () => {
  const { source } = readOtherBranch();
  assert.ok(
    source.indexOf("if (group.isOtherGroup) {") < source.indexOf("if (group.directItems) {"),
    "「其他」分支必须先于 directItems 分支判定",
  );
});

test("「其他」组本身是主菜单里的一级标题，不再是二级子菜单", () => {
  const { branch } = readOtherBranch();
  // 一级标题用 DropdownMenuLabel，标题 key 取合成组自身的 key。
  assert.match(branch, /<DropdownMenuLabel[\s\S]*?data-model-provider-key=\{group\.key\}/);
  // 分支里唯一的子菜单触发器属于供应商分段，不属于「其他」组自身。
  assert.match(
    branch,
    /<DropdownMenuSubTrigger[\s\S]*?data-model-provider-key=\{subSection\.key\}/,
  );
  assert.doesNotMatch(branch, /<DropdownMenuSubTrigger[\s\S]*?data-model-provider-key=\{group\.key\}/);
});

test("「其他」下的供应商渲染为二级子菜单，模型落在三级", () => {
  const { branch } = readOtherBranch();
  assert.match(branch, /\{\(group\.subSections \?\? \[\]\)\.map\(\(subSection\) => \{/);
  assert.match(branch, /<DropdownMenuSub key=\{subSection\.key\}>/);
  assert.match(branch, /<DropdownMenuSubContent[\s\S]*?\{renderModelItems\(subSection\.items\)\}/);
});

test("二级菜单分支不再按 subSections 平铺渲染", () => {
  const { source } = readOtherBranch();
  // 旧的「其他」二级菜单内平铺分段写法已删除，避免回退成两层结构。
  assert.doesNotMatch(source, /subSections\.length > 0/);
});
