import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnSummaryPersistOpenKey } from "../src/v4/conversationTurnSummaryOpenKey.js";

const SUMMARY_KEY = "turnSummary:row:4";

test("摘要展开键同时携带 sessionId、logEpoch 与首项身份", () => {
  const key = buildTurnSummaryPersistOpenKey("sess-child", "epoch-1", SUMMARY_KEY);

  assert.equal(key, "zc-turn-summary:sess-child:epoch-1:turnSummary:row:4");
  assert.equal(buildTurnSummaryPersistOpenKey("sess-child", "epoch-1", SUMMARY_KEY), key);
});

test("不同 Subagent 的相同 rowId 使用不同展开键", () => {
  const first = buildTurnSummaryPersistOpenKey("sess-child-a", "epoch-1", SUMMARY_KEY);
  const second = buildTurnSummaryPersistOpenKey("sess-child-b", "epoch-1", SUMMARY_KEY);

  assert.notEqual(first, second);
});

test("logEpoch 变化后不复用旧物化纪元的展开键", () => {
  const first = buildTurnSummaryPersistOpenKey("sess-child", "epoch-1", SUMMARY_KEY);
  const second = buildTurnSummaryPersistOpenKey("sess-child", "epoch-2", SUMMARY_KEY);

  assert.notEqual(first, second);
});

test("作用域缺失时使用稳定回退，不会抛错", () => {
  assert.equal(
    buildTurnSummaryPersistOpenKey(undefined, null, SUMMARY_KEY),
    "zc-turn-summary:::turnSummary:row:4",
  );
  assert.equal(
    buildTurnSummaryPersistOpenKey(" sess-child ", " epoch-1 ", SUMMARY_KEY),
    buildTurnSummaryPersistOpenKey("sess-child", "epoch-1", SUMMARY_KEY),
  );
});
