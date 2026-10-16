import assert from "node:assert/strict";
import test from "node:test";
import type { ModelToolCall } from "@zcode/contracts";
import { resolveStreamToolResults } from "../src/model/stream-tool-results.js";

test("stream tool results are normalized and correlated by tool call id", async () => {
  const toolCalls = [
    {
      id: "call-image",
      name: "image_generation",
      input: { prompt: "test" },
      providerExecuted: true,
    },
  ] satisfies ModelToolCall[];
  const result = await resolveStreamToolResults(
    {
      toolResults: Promise.resolve([
        {
          toolCallId: "call-image",
          toolName: "image_generation",
          result: { result: "base64" },
          providerExecuted: true,
        },
      ]),
    } as never,
    toolCalls,
  );
  assert.deepEqual(result, [
    {
      id: "call-image",
      name: "image_generation",
      input: { prompt: "test" },
      output: { result: "base64" },
      providerExecuted: true,
      providerMetadata: undefined,
    },
  ]);
});
