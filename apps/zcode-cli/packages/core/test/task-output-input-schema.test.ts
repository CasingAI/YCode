import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_OUTPUT_PROVIDER_DESCRIPTION,
  TaskOutputInputJsonSchema,
  TaskOutputInputSchema,
  TaskOutputResultSchema,
} from "@zcode/contracts";

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

test("TaskOutput 结果接受 waited_ms", () => {
  const parsed = TaskOutputResultSchema.parse({
    retrieval_status: "timeout",
    waited_ms: 120_034,
    task: null,
  });

  assert.equal(parsed.waited_ms, 120_034);
});

test("TaskOutput 结果在缺 waited_ms 时仍能解析（兼容既有持久化数据）", () => {
  const parsed = TaskOutputResultSchema.parse({ retrieval_status: "success", task: null });

  assert.equal(parsed.waited_ms, undefined);
});

test("TaskOutput 结果拒绝负数或非整数的 waited_ms", () => {
  assert.equal(
    TaskOutputResultSchema.safeParse({ retrieval_status: "timeout", waited_ms: -1, task: null })
      .success,
    false,
  );
  assert.equal(
    TaskOutputResultSchema.safeParse({ retrieval_status: "timeout", waited_ms: 1.5, task: null })
      .success,
    false,
  );
});

test("TaskOutput provider 描述不再指向不存在的 /tasks 命令", () => {
  // /tasks 不是内置斜杠命令，模型照着描述去调只会失败。
  assert.equal(TASK_OUTPUT_PROVIDER_DESCRIPTION.includes("/tasks"), false);
  assert.match(TASK_OUTPUT_PROVIDER_DESCRIPTION, /timeout/);
});