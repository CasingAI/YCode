import assert from "node:assert/strict";
import test from "node:test";
import {
  executePlanSubmission,
  resolvePlanExecuteTarget,
} from "../src/lib/planExecutionMode.js";

// docs/specs/plan-card-execute.md 规则 22：点击旧计划时的执行目标读取优先级。
// 目标只来自快照 config.planExecuteMode 与 composer 草稿/会话档，不按计划历史推断，
// 且任何分支都不得恢复 readonly。

test("resolvePlanExecuteTarget：Plan 内取快照权威 planExecuteMode", () => {
  assert.equal(
    resolvePlanExecuteTarget({
      snapshotConfig: { mode: "plan", planExecuteMode: "team" },
      draftMode: "yolo",
    }),
    "team",
  );
  assert.equal(
    resolvePlanExecuteTarget({
      snapshotConfig: { mode: "plan", planExecuteMode: "yolo" },
      draftMode: "team",
    }),
    "yolo",
  );
});

test("resolvePlanExecuteTarget：Plan 内忽略草稿，冷快照缺字段按 yolo", () => {
  assert.equal(
    resolvePlanExecuteTarget({
      snapshotConfig: { mode: "plan" },
      draftMode: "team",
    }),
    "yolo",
  );
  assert.equal(
    resolvePlanExecuteTarget({
      snapshotConfig: { mode: "plan", planExecuteMode: "readonly" },
      draftMode: "team",
    }),
    "yolo",
  );
});

test("resolvePlanExecuteTarget：非 Plan 保留草稿 team / yolo", () => {
  assert.equal(
    resolvePlanExecuteTarget({
      snapshotConfig: { mode: "readonly" },
      draftMode: "team",
    }),
    "team",
  );
  assert.equal(
    resolvePlanExecuteTarget({
      snapshotConfig: { mode: "team" },
      draftMode: "yolo",
    }),
    "yolo",
  );
});

test("resolvePlanExecuteTarget：草稿 plan / readonly / 缺失回退会话 team / yolo", () => {
  for (const draftMode of ["plan", "readonly", undefined, null, "build"]) {
    assert.equal(
      resolvePlanExecuteTarget({
        snapshotConfig: { mode: "team" },
        draftMode,
      }),
      "team",
    );
    assert.equal(
      resolvePlanExecuteTarget({
        snapshotConfig: { mode: "yolo" },
        draftMode,
      }),
      "yolo",
    );
  }
});

test("resolvePlanExecuteTarget：无法得到 team / yolo 时用 yolo，绝不返回 readonly", () => {
  const inputs = [
    { snapshotConfig: { mode: "readonly" }, draftMode: "plan" },
    { snapshotConfig: { mode: "plan", planExecuteMode: "readonly" }, draftMode: "readonly" },
    { snapshotConfig: { mode: "readonly" }, draftMode: "readonly" },
    { snapshotConfig: null, draftMode: undefined },
    { snapshotConfig: undefined, draftMode: "plan" },
  ];
  for (const input of inputs) {
    assert.equal(resolvePlanExecuteTarget(input), "yolo");
  }
});

test("resolvePlanExecuteTarget：从 Team 执行后再次点击旧计划保持 Team", () => {
  // 第一次执行：Plan 内快照给出 Team。
  const first = resolvePlanExecuteTarget({
    snapshotConfig: { mode: "plan", planExecuteMode: "team" },
    draftMode: "plan",
  });
  assert.equal(first, "team");
  // 执行后 runtime 已离开 Plan，会话档与草稿都是 Team；旧计划仍取 Team。
  assert.equal(
    resolvePlanExecuteTarget({
      snapshotConfig: { mode: "team" },
      draftMode: "team",
    }),
    "team",
  );
});

test("executePlanSubmission：同一同步栈先切档再发送，发送时读到新档", () => {
  const calls: string[] = [];
  let draftMode: string = "plan";
  const target = executePlanSubmission({
    snapshotConfig: { mode: "plan", planExecuteMode: "team" },
    draftMode,
    switchMode: (mode) => {
      calls.push(`switch:${mode}`);
      // 等价于 useDraftConfigControl 的同步 ref 写入：发送闭包随后读到的就是新值。
      draftMode = mode;
    },
    sendText: () => {
      calls.push(`send:${draftMode}`);
    },
  });
  assert.equal(target, "team");
  assert.deepEqual(calls, ["switch:team", "send:team"]);
});

test("executePlanSubmission：非 Plan 缺草稿时用会话档，send 不带 readonly", () => {
  const calls: string[] = [];
  executePlanSubmission({
    snapshotConfig: { mode: "readonly" },
    draftMode: "plan",
    switchMode: (mode) => calls.push(mode),
    sendText: () => calls.push("send"),
  });
  assert.deepEqual(calls, ["yolo", "send"]);
});
