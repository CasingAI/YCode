import assert from "node:assert/strict";
import test from "node:test";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import { selectExecutionErrorMessage } from "../src/errors/error-payload.js";

test("失败文本只保留 error 文本，不带归因方括号", () => {
  const error = createCoreError(
    CoreErrorType.ModelError,
    "Network connection failed for the provider request.",
    {
      context: {
        source: "network",
        errorPhase: "stream",
        providerId: "opencode-go-responses",
      },
    },
  );

  const message = selectExecutionErrorMessage(error, "fallback");

  assert.equal(message, "Network connection failed for the provider request.");
  assert.doesNotMatch(message, /\[/);
});

test("从 cause 链选主帧文本", () => {
  const cause = createCoreError(CoreErrorType.ModelError, "upstream reset", {
    context: { source: "network" },
  });
  const outer = createCoreError(CoreErrorType.ToolExecutionFailed, "Subagent failed", { cause });

  assert.equal(selectExecutionErrorMessage(outer), "Subagent failed");
});
