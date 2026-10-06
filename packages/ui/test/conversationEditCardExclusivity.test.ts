import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// specs/message-history-edit.md 规则 38：编辑卡失焦退出 + 全局单卡 + 工具条热键让位。
// ui 包测试为源码断言式（无组件渲染），这里锁定各文件的实现要点防回退。

test("规则 38：开合通知携带 rowId 做 owner 感知，宿主 close 只清仍指向自己的 state", () => {
  const ctx = read("../src/v4/conversationRowContext.ts");
  assert.match(ctx, /onEditCardOpenChange\?: \(rowId: number, open: boolean\) => void;/);

  const pane = read("../src/v4/SessionPane.tsx");
  // owner 感知 setter：open 直接指向；close 必须校验 current === rowId。
  assert.match(pane, /setEditingRowId\(\(current\) =>/);
  assert.match(pane, /current === rowId \? null : current/);
});

test("规则 38：编辑卡互斥退出 + 卡外 pointerdown 失焦退出（portal 不算失焦）", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  // 单卡互斥：宿主确认本卡为 owner 后，editingRowId 被别的卡占用才自关
  //（新卡打开瞬间宿主 state 还停留在旧卡 rowId，未确认前不得误关）。
  assert.match(rowView, /hostConfirmedRef\.current = true/);
  assert.match(rowView, /else if \(hostConfirmedRef\.current\)/);
  // 失焦退出：document 捕获阶段 pointerdown，行容器内放行，portal（body 直下）放行。
  assert.match(rowView, /addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(rowView, /closest\(`\[data-row-id="\$\{row\.rowId\}"\]`\)/);
  assert.match(rowView, /node\.id === "root"/);
  // submitting 期间不退出。
  assert.match(rowView, /if \(!editing \|\| submitting\) return;/);
});

test("规则 38：编辑卡打开时主 composer 工具条热键让位，编辑卡控件接管", () => {
  const shortcuts = read("../src/v4/composer/toolbarShortcuts.ts");
  assert.match(shortcuts, /suppressed\?: boolean;/);
  assert.match(shortcuts, /if \(suppressed \|\| !hasAnyOption\)/);

  const toolbar = read("../src/v4/composer/V4ComposerToolbar.tsx");
  assert.match(toolbar, /hotkeysSuppressed\?: boolean;/);
  assert.match(toolbar, /suppressed: hotkeysSuppressed/);

  const composer = read("../src/v4/ConversationComposer.tsx");
  assert.match(composer, /editCardHotkeysSuppressed = false/);
  // 主 composer 的模型簇与模式簇都要吃让位标志。
  assert.match(composer, /hotkeysSuppressed=\{editCardHotkeysSuppressed\}/);

  const pane = read("../src/v4/SessionPane.tsx");
  assert.match(pane, /editCardHotkeysSuppressed=\{editingRowId !== null\}/);
});

test("规则 39：被动关闭停靠半编辑草稿，重开恢复；显式取消/提交成功丢弃", () => {
  const ctx = read("../src/v4/conversationRowContext.ts");
  // 停靠接口：{base, text}，base 用于重开时校验行原文未变。
  assert.match(ctx, /readParkedEditDraft\?: \(rowId: number\) => \{ base: string; text: string \} \| null;/);
  assert.match(ctx, /parkEditDraft\?: \(rowId: number, draft: \{ base: string; text: string \} \| null\) => void;/);

  const pane = read("../src/v4/SessionPane.tsx");
  // 宿主停靠存储：sessionId:rowId 复合 key（rowId 跨会话重号），ref Map 不参与渲染。
  assert.match(pane, /parkedEditDraftsRef = useRef\(new Map</);
  assert.match(pane, /\$\{sessionIdRef\.current \?\? ""\}:\$\{rowId\}/);

  const rowView = read("../src/v4/ConversationRowView.tsx");
  // 被动关闭（auto）停靠、显式丢弃清除，卸载也走同一条关卡清理。
  assert.match(rowView, /closeReasonRef\.current === "auto" && contextParkEditDraft/);
  assert.match(rowView, /contextParkEditDraft\?\.\(row\.rowId, null\)/);
  // 重开恢复：base 与当前原文一致才恢复，否则回原文。
  assert.match(rowView, /parked\.base === parsedShareContext\.visibleContent \? parked\.text : null/);
  // 编辑卡 initialValue 在开卡时定格（停靠恢复或原文）。
  assert.match(rowView, /initialValue=\{editInitialValue\}/);
  // 显式取消与提交成功都置 discard。
  assert.match(rowView, /closeReasonRef\.current = "discard";/);
  // 被动关闭的复位路径不得清 draft。
  const autoBlock = rowView.split('closeReasonRef.current === "auto"')[1]?.split("return;")[0] ?? "";
  assert.ok(!autoBlock.includes("setDraft("), "auto 关闭路径不应复位 draft");
});

test("规则 13：弱化预览收口在行级（RowView 分发层），Timeline 轮级已移除", () => {
  const rowView = read("../src/v4/ConversationRowView.tsx");
  // 行级判定：rowId 大于编辑目标即弱化（含编辑轮自身的回复行）。
  assert.match(rowView, /row\.rowId > context\.editingRowId/);
  assert.match(rowView, /data-edit-dimmed/);
  assert.match(rowView, /pointer-events-none select-none opacity-40/);

  const timeline = read("../src/v4/ConversationTimeline.tsx");
  // 轮级弱化不得残留：避免与行级叠加把后续行压到 0.16。
  assert.doesNotMatch(timeline, /editDimmed/);
});
