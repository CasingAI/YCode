import assert from "node:assert/strict";
import test from "node:test";
import { buildProcessPersistOpenKey } from "../src/v4/conversationProcessOpenKey.js";

const SUMMARY_KEY = "process:row:4";

test("过程行展开键同时携带 sessionId、logEpoch 与首项身份", () => {
  const key = buildProcessPersistOpenKey("sess-child", "epoch-1", SUMMARY_KEY);

  assert.equal(key, "zc-turn-process:sess-child:epoch-1:process:row:4");
  assert.equal(buildProcessPersistOpenKey("sess-child", "epoch-1", SUMMARY_KEY), key);
});

test("不同 Subagent 的相同 rowId 使用不同展开键", () => {
  const first = buildProcessPersistOpenKey("sess-child-a", "epoch-1", SUMMARY_KEY);
  const second = buildProcessPersistOpenKey("sess-child-b", "epoch-1", SUMMARY_KEY);

  assert.notEqual(first, second);
});

test("logEpoch 变化后不复用旧物化纪元的展开键", () => {
  const first = buildProcessPersistOpenKey("sess-child", "epoch-1", SUMMARY_KEY);
  const second = buildProcessPersistOpenKey("sess-child", "epoch-2", SUMMARY_KEY);

  assert.notEqual(first, second);
});

test("作用域缺失时使用稳定回退，不会抛错", () => {
  assert.equal(
    buildProcessPersistOpenKey(undefined, null, SUMMARY_KEY),
    "zc-turn-process:::process:row:4",
  );
  assert.equal(
    buildProcessPersistOpenKey(" sess-child ", " epoch-1 ", SUMMARY_KEY),
    buildProcessPersistOpenKey("sess-child", "epoch-1", SUMMARY_KEY),
  );
});
