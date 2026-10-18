import assert from "node:assert/strict";
import test from "node:test";
import { shouldRecordModelIO } from "../src/model/runner-debug.js";

test("模型轨迹记录开关关闭时拒绝新的记录", () => {
  assert.equal(shouldRecordModelIO({ ZCODE_RUNTIME_ENV: "production" }, false), false);
});

test("模型轨迹记录默认开启且测试环境仍不写入", () => {
  assert.equal(shouldRecordModelIO({ ZCODE_RUNTIME_ENV: "production" }), true);
  assert.equal(shouldRecordModelIO({ ZCODE_RUNTIME_ENV: "test" }), false);
});
