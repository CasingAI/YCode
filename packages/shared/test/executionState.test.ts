import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeLegacyExecutionMode,
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
