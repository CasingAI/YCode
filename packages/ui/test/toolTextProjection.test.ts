import assert from "node:assert/strict";
import test from "node:test";
import {
  readSandboxOutputProjection,
  stripSystemReminderBlocks,
} from "../src/ToolCallBlocks/toolTextProjection.js";

// 工具结果文本的用户视图投影：模型信封剥离（见 docs/specs/sandbox-system-tool.md
// 「聊天工具卡」）。新实例提示仅模型可见，用户侧完全不显示。

test("stripSystemReminderBlocks：整块移除 reminder 并收敛空行", () => {
  const input =
    "<system-reminder>这是新沙盒实例：旧堆内存没了，LocalStorage 还在。</system-reminder>\n\n<return>\n2\n</return>";
  assert.equal(stripSystemReminderBlocks(input), "<return>\n2\n</return>");
});

test("stripSystemReminderBlocks：多块与行内块都移除", () => {
  const input =
    "报错信息\n\n<system-reminder>第一块</system-reminder>\n\n正文\n\n<system-reminder>第二块</system-reminder>";
  assert.equal(stripSystemReminderBlocks(input), "报错信息\n\n正文");
});

test("stripSystemReminderBlocks：无 reminder 原样返回", () => {
  assert.equal(stripSystemReminderBlocks("plain text"), "plain text");
});

test("stripSystemReminderBlocks：纯 reminder 文本剥后为空", () => {
  assert.equal(
    stripSystemReminderBlocks("<system-reminder>只有提示</system-reminder>"),
    "",
  );
});

test("readSandboxOutputProjection：取出 return 与 console 正文，信封不保留", () => {
  const projection = readSandboxOutputProjection(
    "<system-reminder>新实例提示</system-reminder>\n\n<return>\n2\n</return>\n\n<console>\nhello\n</console>",
  );
  assert.equal(projection.returnText, "2");
  assert.equal(projection.consoleText, "hello");
});

test("readSandboxOutputProjection：只有 return 时 console 缺席", () => {
  const projection = readSandboxOutputProjection("<return>\n2\n</return>");
  assert.equal(projection.returnText, "2");
  assert.equal(projection.consoleText, undefined);
});

test("readSandboxOutputProjection：无信封文本回退为 console 正文且仍剥 reminder", () => {
  const projection = readSandboxOutputProjection(
    "<system-reminder>提示</system-reminder>\n\n纯文本输出",
  );
  assert.equal(projection.returnText, undefined);
  assert.equal(projection.consoleText, "纯文本输出");
});

test("readSandboxOutputProjection：空文本返回空投影", () => {
  assert.deepEqual(readSandboxOutputProjection("   "), {});
});
