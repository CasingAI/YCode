import assert from "node:assert/strict";
import test from "node:test";
import {
  commandPayloadSchemas,
  commandResultSchema,
} from "../src/zcode-protocol-v4/command.js";
import { sandboxConsoleSnapshotSchema } from "../src/sandbox-console.js";

// 沙盒控制台可交互命令的协议面（docs/specs/sandbox-system-tool.md 阶段8）：
// sandboxEval（用户输入一行立刻 eval）与 sandboxReset（销毁实例、LS 留下）。
// 失败态用协议 kind，不靠抛错；命令本身不携 baseRevision（与 cancelBackgroundWork 同类）。

test("sandboxEval payload：非空 code，有界 64KiB", () => {
  assert.equal(commandPayloadSchemas.sandboxEval.safeParse({ code: "1 + 1" }).success, true);
  assert.equal(commandPayloadSchemas.sandboxEval.safeParse({ code: "" }).success, false);
  assert.equal(commandPayloadSchemas.sandboxEval.safeParse({ code: "   " }).success, true);
  assert.equal(
    commandPayloadSchemas.sandboxEval.safeParse({ code: "x".repeat(65537) }).success,
    false,
  );
  assert.equal(commandPayloadSchemas.sandboxEval.safeParse({}).success, false);
});

test("sandboxReset payload：无载荷", () => {
  assert.equal(commandPayloadSchemas.sandboxReset.safeParse({}).success, true);
});

test("sandboxEval ACK result：completed 带 returnText/console，failed 带 kind", () => {
  const completed = commandResultSchema.safeParse({
    type: "sandboxEval",
    result: {
      kind: "completed",
      sessionId: "sess_1",
      returnText: "42",
      console: "",
      consoleTruncated: false,
    },
  });
  assert.equal(completed.success, true);

  const failed = commandResultSchema.safeParse({
    type: "sandboxEval",
    result: { kind: "failed", sessionId: "sess_1", code: "SyntaxError", message: "bad" },
  });
  assert.equal(failed.success, true);
});

test("sandboxReset ACK result：reset 与 unavailable", () => {
  assert.equal(
    commandResultSchema.safeParse({
      type: "sandboxReset",
      result: { kind: "reset", sessionId: "sess_1" },
    }).success,
    true,
  );
  assert.equal(
    commandResultSchema.safeParse({
      type: "sandboxReset",
      result: { kind: "unavailable", sessionId: "sess_1" },
    }).success,
    true,
  );
});

test("sandboxConsole 快照执行行：摘要 + 有界全文只读", () => {
  const snapshot = {
    kind: "output",
    sessionId: "sess_1",
    alive: true,
    executions: [
      {
        seq: 1,
        source: "user",
        preview: "globalThis.big = …",
        truncated: true,
        code: 'globalThis.big = "xxx";',
        codeTruncated: false,
        at: 1,
      },
    ],
    lines: [],
    truncated: false,
  };
  assert.equal(sandboxConsoleSnapshotSchema.safeParse(snapshot).success, true);
  // 全文缺席即拒绝：只读专用视图的展示源必须随快照下发。
  const missing = {
    ...snapshot,
    executions: [
      { seq: 1, source: "user", preview: "x", truncated: false, at: 1 },
    ],
  };
  assert.equal(sandboxConsoleSnapshotSchema.safeParse(missing).success, false);
});
