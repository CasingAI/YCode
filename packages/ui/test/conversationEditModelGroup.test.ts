import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

// docs/specs/model-group.md「编辑历史消息的组语义」+ specs/message-history-edit.md 规则 44：
// 编辑历史消息的行内编辑卡支持选择模型组。修复前编辑卡只传 onSelectModel、不传
// onSelectModelGroup，工具条对组值（model-group:<groupId>）走可选调用静默失败——
// 菜单照常关闭但既没选中也没切换（死可供性）。ui 包测试为源码断言式（无组件渲染）。

test("编辑卡把组选择回调接进模型控件簇（死可供性修复点）", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  // 编辑卡内的 V4ComposerModelControls 必须传 onSelectModelGroup。
  const controlsBlock = rowView.slice(
    rowView.indexOf("<V4ComposerModelControls"),
    rowView.indexOf("forceCompactModelTrigger"),
  );
  assert.match(controlsBlock, /onSelectModelGroup=\{handleEditSelectModelGroup\}/);
});

test("工具条与主 composer 的组回调改为必填：菜单出现组条目必须有消费方", () => {
  const toolbar = read("../src/v4/composer/V4ComposerToolbar.tsx");
  // 可选回调（onSelectModelGroup?）会让组值走静默 no-op——本次修复的根因，禁止回退。
  assert.doesNotMatch(toolbar, /onSelectModelGroup\?/);
  assert.doesNotMatch(toolbar, /onSelectModelGroup\?\./);
  assert.match(toolbar, /onSelectModelGroup: \(groupId: string, groupName: string\) => void;/);
  const composer = read("../src/v4/ConversationComposer.tsx");
  assert.doesNotMatch(composer, /onSelectModelGroup\?:/);
});

test("编辑卡组意图与具体模型互斥：选组清具体选择，选具体模型清组意图", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  const groupHandler = rowView.slice(
    rowView.indexOf("const handleEditSelectModelGroup"),
    rowView.indexOf("const handleEditSelectModelGroup") + 400,
  );
  assert.match(groupHandler, /setEditModelSelection\(undefined\);/);
  assert.match(groupHandler, /setEditModelGroupIntent\(\{ groupId, groupNameSnapshot: groupName \}\);/);
  const modelHandler = rowView.slice(
    rowView.indexOf("const handleEditSelectModel"),
    rowView.indexOf("const handleEditSelectModelGroup"),
  );
  assert.match(modelHandler, /setEditModelGroupIntent\(undefined\);/);
  // 草稿投影互斥：有组意图时不再投影具体选择（档位控件随空选择隐藏）。
  assert.match(
    rowView,
    /\.\.\.\(editModelGroupIntent\s*\n?\s*\? \{ modelGroupIntent: editModelGroupIntent \}/,
  );
});

test("提交互斥：组意图与具体模型二选一随 editUserQuery 带出", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  assert.match(
    rowView,
    /\.\.\.\(editModelGroupIntent\s*\n?\s*\? \{ modelGroupIntent: editModelGroupIntent \}\s*\n?\s*: \{ modelSelection: editModelSelection \}\),/,
  );
  const pane = read("../src/v4/SessionPane.tsx");
  // payload 组装：组意图与具体模型条件展开并存（编辑卡保证只带一项）。
  assert.match(pane, /\.\.\.\(overrides\?\.modelGroupIntent/);
  assert.match(pane, /\.\.\.\(overrides\?\.modelSelection \? \{ modelSelection: overrides\.modelSelection \} : \{\}\),/);
});

test("开卡回填与复位点覆盖组意图", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  // 状态初值与开卡/取消/被动关闭三处复位都读 row.admissionModelGroupIntent。
  const resets = rowView.match(/setEditModelGroupIntent\(row\.admissionModelGroupIntent\);/g) ?? [];
  assert.ok(resets.length >= 4, `复位点应至少 4 处（初值 + 开卡 + 取消 + 关闭），实际 ${resets.length}`);
});

test("组失败前置的行内文案：blocked reasonCode 映射两条组失败码", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  assert.match(rowView, /reasonCode === "modelGroup\.deleted"\s*\n?\s*\? "chat\.modelGroup\.sendFailedDeleted"/);
  assert.match(
    rowView,
    /reasonCode === "modelGroup\.noMembers"\s*\n?\s*\? "chat\.modelGroup\.sendFailedNoMembers"/,
  );
  const zh = read("../src/i18n/locales/zh-CN.ts");
  assert.match(zh, /"chat\.modelGroup\.sendFailedDeleted"/);
  assert.match(zh, /"chat\.modelGroup\.sendFailedNoMembers"/);
});
