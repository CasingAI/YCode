import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeLegacyExecutionMode,
  normalizeLegacyExecutionState,
  resolveExecutionState,
  resolvePersistedExecutionMode,
} from "../src/execution-state.js";

test("持久化模式严格解析保留四档并迁移旧秘书档", () => {
  for (const mode of ["plan", "readonly", "yolo", "team"] as const) {
    assert.equal(resolvePersistedExecutionMode(mode), mode);
    assert.equal(resolvePersistedExecutionMode({ mode }), mode);
  }
  assert.equal(resolvePersistedExecutionMode("bare"), "team");
  assert.equal(resolvePersistedExecutionMode({ mode: "bare" }), "team");
});

test("持久化模式缺失或不可判定时不生成种子，旧迁移仍返回默认档", () => {
  for (const raw of [undefined, null, "", "build", "edit", "auto", "unknown", 42, {}, []]) {
    assert.equal(resolvePersistedExecutionMode(raw), undefined, JSON.stringify(raw));
    assert.equal(normalizeLegacyExecutionMode(raw), "yolo", JSON.stringify(raw));
  }
});

test("旧计划与只读叠加位保持限制档优先级", () => {
  for (const [raw, expected] of [
    [{ mode: "build", planEnabled: true }, "plan"],
    [{ mode: "yolo", readOnlyEnabled: true }, "readonly"],
    [{ mode: "readonly", planEnabled: true }, "plan"],
    [{ mode: "team", planEnabled: true, readOnlyEnabled: true }, "plan"],
  ] as const) {
    assert.equal(resolvePersistedExecutionMode(raw), expected);
    assert.equal(normalizeLegacyExecutionMode(raw), expected);
  }
});

// ---------------------------------------------------------------
// planExecuteMode：Plan 内的单值附注，不是第五档
// ---------------------------------------------------------------

test("进入 Plan 由来源档派生目标：Team → team，其余 → yolo", () => {
  assert.deepEqual(resolveExecutionState({ mode: "plan" }, { mode: "team" }), {
    mode: "plan",
    planExecuteMode: "team",
  });
  for (const source of ["yolo", "readonly", "plan"] as const) {
    assert.deepEqual(resolveExecutionState({ mode: "plan" }, { mode: source }), {
      mode: "plan",
      planExecuteMode: "yolo",
    });
  }
});

test("已在 Plan 内重复进入保留已有合法目标，不重算来源", () => {
  assert.deepEqual(
    resolveExecutionState({ mode: "plan" }, { mode: "plan", planExecuteMode: "team" }),
    { mode: "plan", planExecuteMode: "team" },
  );
  assert.deepEqual(
    resolveExecutionState({ mode: "plan" }, { mode: "plan", planExecuteMode: "yolo" }),
    { mode: "plan", planExecuteMode: "yolo" },
  );
});

test("离开 Plan 清空目标；命令输入自带的 planExecuteMode 不可信", () => {
  for (const mode of ["yolo", "readonly", "team"] as const) {
    assert.deepEqual(resolveExecutionState({ mode }, { mode: "plan", planExecuteMode: "team" }), {
      mode,
    });
  }
  assert.deepEqual(
    resolveExecutionState({ mode: "yolo", planExecuteMode: "team" } as { mode: string }, {
      mode: "plan",
      planExecuteMode: "team",
    }),
    { mode: "yolo" },
  );
});

test("旧数据与新建无来源 Plan：缺目标按 yolo 兼容", () => {
  assert.deepEqual(normalizeLegacyExecutionState("plan"), {
    mode: "plan",
    planExecuteMode: "yolo",
  });
  assert.deepEqual(normalizeLegacyExecutionState({ mode: "plan" }), {
    mode: "plan",
    planExecuteMode: "yolo",
  });
  assert.deepEqual(normalizeLegacyExecutionState({ mode: "plan", planExecuteMode: "bogus" }), {
    mode: "plan",
    planExecuteMode: "yolo",
  });
  assert.deepEqual(normalizeLegacyExecutionState({ mode: "plan", planExecuteMode: "team" }), {
    mode: "plan",
    planExecuteMode: "team",
  });
  // 非 Plan 一律丢弃目标，不让旧 Team 目标污染下一次进入。
  assert.deepEqual(normalizeLegacyExecutionState({ mode: "team", planExecuteMode: "team" }), {
    mode: "team",
  });
  assert.deepEqual(normalizeLegacyExecutionState({ mode: "build", planEnabled: true }), {
    mode: "plan",
    planExecuteMode: "yolo",
  });
});
