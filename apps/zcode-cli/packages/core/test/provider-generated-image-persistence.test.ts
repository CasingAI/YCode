import assert from "node:assert/strict";
import test from "node:test";
import type { ModelToolResult, ToolArtifactStorePort } from "@zcode/contracts";
import { persistProviderGeneratedImages } from "../src/runtime/helpers/provider-image-persistence.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
const baseInput = {
  assistantMessageId: "assistant-1" as never,
  content: "![示意图](attachment:generated-image)",
  results: [
    {
      id: "call-1",
      name: "image_generation",
      input: {},
      output: { result: png },
      providerExecuted: true,
    },
  ] satisfies ModelToolResult[],
  sessionId: "session-1" as never,
  traceContext: {} as never,
};

function artifactStore(
  write: ToolArtifactStorePort["writeToolResultArtifact"],
): ToolArtifactStorePort {
  return {
    writeToolResultArtifact: write,
    readToolResultArtifact: async ({ uri }) => ({
      uri,
      content: `data:image/png;base64,${png}`,
      contentType: "text/plain",
      bytes: png.length,
    }),
  };
}

test("provider 图片按 tool result 写为 session artifact 并替换正文引用", async () => {
  let request: Parameters<ToolArtifactStorePort["writeToolResultArtifact"]>[0] | undefined;
  const result = await persistProviderGeneratedImages({
    ...baseInput,
    artifactStore: artifactStore(async (value) => {
      request = value;
      return {
        id: "artifact-1",
        uri: "zcode-artifact://artifact-1",
        bytes: 10,
        contentType: "text/plain",
        createdAt: new Date(),
      };
    }),
  });
  assert.equal(result, "![示意图](zcode-artifact://artifact-1)");
  assert.equal(request?.retention, "session");
  assert.equal(request?.toolCallId, "call-1-image-1");
  assert.equal(request?.content, `data:image/png;base64,${png}`);
});

test("artifact 写入失败或图片无效时保留正文并替换为不可用提示", async () => {
  const store = artifactStore(async () => {
    throw new Error("disk full");
  });
  const failed = await persistProviderGeneratedImages({ ...baseInput, artifactStore: store });
  assert.equal(failed, "![示意图] 图片不可用");
  const invalid = await persistProviderGeneratedImages({
    ...baseInput,
    results: [{ ...baseInput.results[0]!, output: { result: "not-base64" } }],
    artifactStore: store,
  });
  assert.equal(invalid, "![示意图] 图片不可用");
});

test("非 provider 或非 image_generation 结果不触发 artifact 写入", async () => {
  let writes = 0;
  const result = await persistProviderGeneratedImages({
    ...baseInput,
    results: [{ ...baseInput.results[0]!, providerExecuted: false }],
    artifactStore: artifactStore(async () => {
      writes += 1;
      throw new Error("unexpected write");
    }),
  });
  assert.equal(writes, 0);
  assert.equal(result, "![示意图] 图片不可用");
});

test("多个 provider 图片按 tool-call ID 与图片顺序映射", async () => {
  const secondPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString("base64");
  const writeOrder: string[] = [];
  const result = await persistProviderGeneratedImages({
    ...baseInput,
    content:
      "![第一](attachment:generated-image) ![第二](attachment:generated-image) ![第三](attachment:generated-image)",
    toolCallIds: ["call-2", "call-1"],
    results: [
      { ...baseInput.results[0]!, id: "call-1" },
      { ...baseInput.results[0]!, id: "call-2", output: { result: secondPng } },
    ],
    artifactStore: artifactStore(async (request) => {
      writeOrder.push(request.toolCallId);
      return {
        id: `artifact-${writeOrder.length}`,
        uri: `zcode-artifact://image-${writeOrder.length}`,
        bytes: 10,
        contentType: "text/plain",
        createdAt: new Date(),
      };
    }),
  });
  assert.deepEqual(writeOrder, ["call-2-image-1", "call-1-image-1"]);
  assert.equal(
    result,
    "![第一](zcode-artifact://image-1) ![第二](zcode-artifact://image-2) ![第三] 图片不可用",
  );
});

test("无 tool-call ID 时按 provider 结果顺序映射图片", async () => {
  const result = await persistProviderGeneratedImages({
    ...baseInput,
    toolCallIds: undefined,
    artifactStore: artifactStore(async () => ({
      id: "artifact-fallback",
      uri: "zcode-artifact://fallback",
      bytes: 10,
      contentType: "text/plain",
      createdAt: new Date(),
    })),
  });
  assert.equal(result, "![示意图](zcode-artifact://fallback)");
});
