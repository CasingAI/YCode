import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import { ModelRetryBudget } from "@zcode/contracts";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import { retryAllowedByFailurePolicy } from "../src/model/workflow-model-failure-policy.js";

// spec: docs/specs/model-retry-all-failures.md
// 主对话（有界预算）除用户取消外全部自动重试；workflow（无上限预算）照旧读策略表。
// 回归背景：opencode-go-responses 400 "Invalid upload request" 曾因 retryable=false
// 在 attempt 1 直接 turn failed。

function httpStatusError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: "https://provider.example/v1/chat",
    requestBodyValues: { prompt: "hi" },
    statusCode,
    isRetryable: false,
  });
}

function boundedRetryable(failure: ReturnType<typeof classifyModelFailure>): boolean {
  return retryAllowedByFailurePolicy(failure, ModelRetryBudget.Default, undefined);
}

test("有界预算：400 invalid_request 可重试", () => {
  const failure = classifyModelFailure(httpStatusError(400, "Invalid upload request."));
  assert.equal(failure.reason, "invalid_request");
  assert.equal(boundedRetryable(failure), true);
});

test("有界预算：401/403 鉴权失败、422、超窗、unknown 均可重试", () => {
  assert.equal(boundedRetryable(classifyModelFailure(httpStatusError(401, "bad key"))), true);
  assert.equal(boundedRetryable(classifyModelFailure(httpStatusError(403, "forbidden"))), true);
  assert.equal(boundedRetryable(classifyModelFailure(httpStatusError(422, "unprocessable"))), true);
  assert.equal(
    boundedRetryable(classifyModelFailure(new Error("mystery failure"))),
    true,
    "兜底 unknown 分类也重试",
  );
});

test("有界预算：429/5xx/网络错误维持可重试（回归）", () => {
  assert.equal(boundedRetryable(classifyModelFailure(httpStatusError(429, "rate limited"))), true);
  assert.equal(
    boundedRetryable(classifyModelFailure(httpStatusError(502, "bad gateway"))),
    true,
  );
  const networkError = new Error("write EPIPE: connection broken");
  (networkError as Error & { code: string }).code = "EPIPE";
  assert.equal(boundedRetryable(classifyModelFailure(networkError)), true);
});

test("有界预算：用户取消不可重试", () => {
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.equal(boundedRetryable(classifyModelFailure(abort)), false);
});

test("无上限预算：仍读策略表，invalid_request 与配额停、5xx 重试（回归）", () => {
  const invalidRequest = classifyModelFailure(httpStatusError(400, "Invalid upload request."));
  assert.equal(
    retryAllowedByFailurePolicy(invalidRequest, ModelRetryBudget.Unbounded, undefined),
    false,
    "策略表 invalid_request → stop",
  );

  const quota = classifyModelFailure(httpStatusError(400, "insufficient quota"));
  assert.equal(
    retryAllowedByFailurePolicy(quota, ModelRetryBudget.Unbounded, "1310"),
    false,
    "策略表配额码 → stop",
  );

  const serverError = classifyModelFailure(httpStatusError(502, "bad gateway"));
  assert.equal(
    retryAllowedByFailurePolicy(serverError, ModelRetryBudget.Unbounded, undefined),
    true,
  );
});
