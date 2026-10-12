import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSessionSubscriptionReasonCode,
  resolveSessionSubscriptionErrorDisplay,
} from "../src/v4/sessionSubscriptionError.js";

// 分级解析只收 UI 侧一份：冷恢复的「正文 (reasonCode)」后缀、store failRecovery
// 的裸码、以及一切解析失败的传输类错误（docs/specs/session-subscription-error-panel.md）。

test("sessionNotFound 后缀：会话已结束，不给重新连接", () => {
  const display = resolveSessionSubscriptionErrorDisplay(
    "Session is not active and not persisted: sess_abc (fault.subscribe.sessionNotFound)",
  );
  assert.deepEqual(display, {
    kind: "sessionEnded",
    retryable: false,
    reasonCode: "fault.subscribe.sessionNotFound",
  });
});

test("resumeFailed 后缀：恢复中途失败，可重试", () => {
  const display = resolveSessionSubscriptionErrorDisplay(
    "Failed to resume persisted session sess_abc: boom (fault.subscribe.resumeFailed)",
  );
  assert.deepEqual(display, {
    kind: "disconnected",
    retryable: true,
    reasonCode: "fault.subscribe.resumeFailed",
  });
});

test("裸 reasonCode（store failRecovery 形式）：fault.subscribe.* 分级，其余按可重试", () => {
  assert.equal(
    resolveSessionSubscriptionErrorDisplay("fault.subscribe.sessionNotFound").kind,
    "sessionEnded",
  );
  // fault.subscription.* 是 store recovery 的码，不是冷恢复家族：按连接类可重试处理。
  const recoveryTimeout = resolveSessionSubscriptionErrorDisplay(
    "fault.subscription.recoveryFrameTimedOut",
  );
  assert.equal(recoveryTimeout.kind, "disconnected");
  assert.equal(recoveryTimeout.retryable, true);
  assert.equal(recoveryTimeout.reasonCode, null);
});

test("runtime 换代耗尽文案与传输类英文错误：一律可重试", () => {
  assert.equal(
    resolveSessionSubscriptionErrorDisplay("ZCode agent runtime 已被回收，重连未成功").retryable,
    true,
  );
  assert.equal(
    resolveSessionSubscriptionErrorDisplay("ZCode agent transport closed").kind,
    "disconnected",
  );
});

test("无码 / 空值 / 非尾部队列不误判", () => {
  assert.equal(parseSessionSubscriptionReasonCode(null), null);
  assert.equal(parseSessionSubscriptionReasonCode(""), null);
  assert.equal(parseSessionSubscriptionReasonCode("boom"), null);
  // reasonCode 只以「尾部括号后缀」或「整串裸码」出现；正文中段提及不算。
  assert.equal(
    parseSessionSubscriptionReasonCode(
      "hint: (fault.subscribe.sessionNotFound) means gone",
    ),
    null,
  );
  // 尾部括号但不是 fault.subscribe.* 家族，不参与分级歧义。
  assert.equal(parseSessionSubscriptionReasonCode("boom (fault.runtime.hookBlocked)"), null);
});

test("尾部括号内其他 fault.subscribe.* 码：可重试且原样带出 reasonCode", () => {
  const display = resolveSessionSubscriptionErrorDisplay("boom (fault.subscribe.resumeFailed)");
  assert.equal(display.reasonCode, "fault.subscribe.resumeFailed");
  const unknownFamily = resolveSessionSubscriptionErrorDisplay("boom (fault.subscribe.hostGone)");
  assert.equal(unknownFamily.retryable, true);
  assert.equal(unknownFamily.reasonCode, "fault.subscribe.hostGone");
});
