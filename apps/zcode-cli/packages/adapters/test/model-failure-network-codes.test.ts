import assert from "node:assert/strict";
import test from "node:test";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import { isNetworkFailure } from "../src/model/failure-inspection.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import { isRetryableProviderBusinessNetworkFailure } from "../src/model/failure-provider-business-codes.js";

// spec: docs/specs/model-failure-network-retry-codes.md
// 传输层断连码必须归类为 NetworkError 且 retryable=true，主对话才会在有界预算内自动重试。
// EPIPE 历史上漏判，落到兜底分支变成 reason=unknown retryable=false，turn 直接失败。

function errorWithCode(code: string): Error {
  const error = new Error(`${code}: connection broken`);
  (error as Error & { code: string }).code = code;
  return error;
}

function businessErrorWithCode(providerCode: string): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode,
    providerId: "test-provider",
    providerKind: "openai-compatible",
    providerMessage: "stream disconnected",
  });
}

test("isNetworkFailure 覆盖 EPIPE 与既有断连码", () => {
  for (const code of ["ECONNRESET", "EPIPE", "ECONNREFUSED", "ENOTFOUND", "UND_ERR_SOCKET"]) {
    assert.equal(isNetworkFailure(code), true, code);
    assert.equal(isNetworkFailure(code.toLowerCase()), true, `${code} 大小写不敏感`);
  }
  assert.equal(isNetworkFailure("EFOO"), false);
  assert.equal(isNetworkFailure(undefined), false);
});

test("EPIPE 分类为可重试的 NetworkError", () => {
  const failure = classifyModelFailure(errorWithCode("EPIPE"));
  assert.equal(failure.reason, "network_error");
  assert.equal(failure.retryable, true);
  assert.equal(failure.statusCode, undefined);
});

test("ECONNRESET 行为保持不变", () => {
  const failure = classifyModelFailure(errorWithCode("ECONNRESET"));
  assert.equal(failure.reason, "network_error");
  assert.equal(failure.retryable, true);
});

test("SSE error chunk 携带 providerCode=EPIPE 时判为可重试网络失败", () => {
  // AI SDK 会把底层断连码包进 ProviderBusinessError.providerCode；
  // isRetryableProviderBusinessNetworkFailure 复用 isNetworkFailure，需同样覆盖 EPIPE。
  assert.equal(
    isRetryableProviderBusinessNetworkFailure(businessErrorWithCode("EPIPE"), "EPIPE"),
    true,
  );
  assert.equal(
    isRetryableProviderBusinessNetworkFailure(businessErrorWithCode("ECONNRESET"), "ECONNRESET"),
    true,
  );
});
