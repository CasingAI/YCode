import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// specs/message-history-edit.md 规则 37：编辑提交被拒不静默。
// 生产构建 renderer 日志 no-op，被拒（ack rejected/stale 等，handleEdit 返回 false）
// 时必须置位卡内行内提示；再提交或重开编辑卡即清除。UI 测试基建为源码断言，
// 与 conversationMessageActionAffordance.test.ts 同款。

const rowViewSource = readFileSync(
  new URL("../src/v4/ConversationRowView.tsx", import.meta.url),
  "utf8",
);
const sharedSource = readFileSync(new URL("../../shared/src/test-ids.ts", import.meta.url), "utf8");
const zhCnSource = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUsSource = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

test("编辑提交被拒时置位行内提示（规则 37）", () => {
  // 被拒分支：result === false 时置位，且成功路径保持原有关卡行为
  assert.ok(
    rowViewSource.includes('setSubmitRejectedMessageId("chat.edit.submitRejected")'),
    "被拒分支必须置位 submitRejectedMessageId（会话内容已更新文案）",
  );
  // dispatch 抛错（连接未就绪/中断）也置位，文案区分连接类失败
  assert.ok(
    rowViewSource.includes('setSubmitRejectedMessageId("chat.edit.submitRejectedConnection")'),
    "catch 分支必须置位连接类失败文案",
  );
  assert.ok(
    /if \(result !== false\) \{\n[\s\S]*?setEditing\(false\);[\s\S]*?\} else \{\n[\s\S]*?setSubmitRejectedMessageId\(/.test(
      rowViewSource,
    ),
    "被拒置位必须只在 result === false 的 else 分支",
  );
  assert.ok(
    /catch \(error\) \{[\s\S]*?setSubmitRejectedMessageId\("chat\.edit\.submitRejectedConnection"\);[\s\S]*?\} finally \{/.test(
      rowViewSource,
    ),
    "catch 必须只包住 onEdit 调用并在 finally 前置位",
  );
  // 编辑卡内渲染提示行（动态消息 id + 专用 testid）
  assert.ok(
    rowViewSource.includes("intl.formatMessage({ id: submitRejectedMessageId })"),
    "编辑卡必须按状态渲染 submitRejectedMessageId 提示",
  );
  assert.ok(
    rowViewSource.includes("TID_V4_EDIT_SUBMIT_REJECTED"),
    "提示行必须使用专用 testid 常量",
  );
});

test("再提交与重开编辑卡都会清除提示（规则 37）", () => {
  // 提交入口开头清除：确保上一次失败的提示不会残留到新的提交尝试
  const submitEntry = rowViewSource.slice(
    rowViewSource.indexOf("const handleSubmitEdit = useCallback"),
    rowViewSource.indexOf("setSubmitting(true);"),
  );
  assert.ok(
    submitEntry.includes("setSubmitRejectedMessageId(null);"),
    "提交开始必须先清除上一次的被拒提示",
  );
  // 打开编辑卡时清除：重开卡不得显示上一次会话状态的提示
  const openCard = rowViewSource.slice(
    rowViewSource.indexOf("setEditModelSelection(row.admissionModelSelection);"),
    rowViewSource.indexOf("setEditing(true);"),
  );
  assert.ok(openCard.includes("setSubmitRejectedMessageId(null);"), "重开编辑卡必须清除被拒提示");
});

test("被拒提示的 i18n 键与 testid 常量齐备", () => {
  assert.ok(
    sharedSource.includes('TID_V4_EDIT_SUBMIT_REJECTED = "v4-edit-submit-rejected"'),
    "shared testid 常量必须定义",
  );
  assert.ok(
    zhCnSource.includes('"chat.edit.submitRejected"') &&
      zhCnSource.includes('"chat.edit.submitRejectedConnection"'),
    "zh-CN 必须有两种被拒提示文案",
  );
  assert.ok(
    enUsSource.includes('"chat.edit.submitRejected"') &&
      enUsSource.includes('"chat.edit.submitRejectedConnection"'),
    "en-US 必须有两种被拒提示文案",
  );
});
