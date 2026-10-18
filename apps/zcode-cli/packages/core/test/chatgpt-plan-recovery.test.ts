import assert from "node:assert/strict";
import test from "node:test";
import { isStreamRecoveryFailureRecoverable } from "../src/runtime/methods/streaming-recovery.js";
import { isModelRequestReplayForbidden } from "../src/runtime/helpers/model-errors.js";

test("禁止重放的模型失败不能被 Core 独立 stream recovery 重新发送", () => {
  const error = Object.assign(new Error("stream interrupted"), {
    context: { requestReplayForbidden: true },
  });
  const wrapped = new Error("model failed", { cause: error });
  assert.equal(isModelRequestReplayForbidden(wrapped), true);
  assert.equal(isStreamRecoveryFailureRecoverable(wrapped), false);
  assert.equal(isStreamRecoveryFailureRecoverable(new Error("ECONNRESET")), true);
});
