import assert from "node:assert/strict";
import test from "node:test";
import { TaskOutputInputJsonSchema, TaskOutputInputSchema } from "@zcode/contracts";

test("TaskOutput timeout 上限收敛到 5 分钟", () => {
  assert.equal(TaskOutputInputSchema.safeParse({ task_id: "exec_a", timeout: 300_000 }).success, true);
  assert.equal(
    TaskOutputInputSchema.safeParse({ task_id: "exec_a", timeout: 300_001 }).success,
    false,
  );
});

test("TaskOutput timeout 省略时取 15 秒", () => {
  const parsed = TaskOutputInputSchema.parse({ task_id: "exec_a" });

  assert.equal(parsed.timeout, 15_000);
  assert.equal(parsed.block, true);
});

test("TaskOutput provider schema 要求三个字段并公开新边界", () => {
  assert.deepEqual(TaskOutputInputJsonSchema.required, ["task_id", "block", "timeout"]);

  const timeout = TaskOutputInputJsonSchema.properties?.timeout as
    | { maximum?: number; default?: number }
    | undefined;
  assert.equal(timeout?.maximum, 300_000);
  assert.equal(timeout?.default, 15_000);
});

test("TaskOutput block 接受字符串形式的布尔值", () => {
  assert.equal(TaskOutputInputSchema.parse({ task_id: "exec_a", block: "false" }).block, false);
  assert.equal(TaskOutputInputSchema.parse({ task_id: "exec_a", block: "true" }).block, true);
});