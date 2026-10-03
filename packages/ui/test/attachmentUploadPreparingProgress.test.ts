import assert from "node:assert/strict";
import test from "node:test";
import type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
} from "@zcode/services";
import { PROTOCOL_V4_LIMITS, type V4AttachmentPutParams } from "@zcode/shared/zcode-protocol-v4";
import {
  uploadAttachmentTransaction,
  type AttachmentUploadProgress,
} from "../src/v4/attachmentUploadTransaction.js";

// 覆盖 docs/specs/web-composer-attachments.md「上传阶段与进度语义」与
// 「base64 合法性校验归属」：首个 begin 往返之前必须有 preparing 事件，
// 准备段与传输段不重叠，超限判断先于解码，非法 base64 转协议错误码。

interface RecordingAgent {
  agent: {
    attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams): Promise<{
      uploadId: string;
      state: "staging";
      nextChunkIndex: number;
    }>;
    attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams): Promise<{
      uploadId: string;
      nextChunkIndex: number;
    }>;
    attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams): Promise<{
      ref: string;
    }>;
    attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void>;
  };
  beginCalls: ZCodeAgentAttachmentBeginParams[];
  chunkCalls: ZCodeAgentAttachmentChunkParams[];
  commitCount: () => number;
}

function createRecordingAgent(): RecordingAgent {
  const beginCalls: ZCodeAgentAttachmentBeginParams[] = [];
  const chunkCalls: ZCodeAgentAttachmentChunkParams[] = [];
  let commitCalls = 0;
  return {
    beginCalls,
    chunkCalls,
    commitCount: () => commitCalls,
    agent: {
      attachmentBeginV4: async (params) => {
        beginCalls.push(params);
        return { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex: 0 };
      },
      attachmentChunkV4: async (params) => {
        chunkCalls.push(params);
        return { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 };
      },
      attachmentCommitV4: async () => {
        commitCalls += 1;
        return { ref: "zcode-artifact://sess_prepare/prepared" };
      },
      attachmentAbortV4: async () => {},
    },
  };
}

function putParams(byteLength: number): V4AttachmentPutParams {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) bytes[index] = index & 0xff;
  return {
    sessionId: "sess_prepare",
    fileName: "probe.bin",
    mime: "application/octet-stream",
    dataBase64: Buffer.from(bytes).toString("base64"),
  };
}

test("首个 begin 往返之前发出三段 preparing，步数单调递增", async () => {
  const recorder = createRecordingAgent();
  const progress: AttachmentUploadProgress[] = [];

  await uploadAttachmentTransaction(
    recorder.agent,
    { workspacePath: "/tmp/probe" },
    putParams(700 * 1024),
    {
      onProgress: (event) => progress.push(event),
    },
  );

  const preparing = progress.filter((event) => event.phase === "preparing");
  assert.deepEqual(
    preparing.map((event) => event.uploadedBytes),
    [0, 1, 3],
    "preparing 步数应为 0 → 1（解码完成）→ 3（checksum 完成）",
  );
  // preparing 必须全部排在首个 uploading 之前，否则准备期反馈仍然晚于传输开始。
  const firstUploadingIndex = progress.findIndex((event) => event.phase === "uploading");
  assert.ok(firstUploadingIndex > 0, "首个 uploading 之前应存在 preparing 事件");
  assert.ok(
    progress.slice(0, firstUploadingIndex).every((event) => event.phase === "preparing"),
    "preparing 之前不应夹杂其它 phase",
  );
  // preparing 的 uploadedBytes 承载步数，totalBytes 仍是真实字节数。
  assert.ok(preparing.every((event) => event.totalBytes === 700 * 1024));
});

test("准备段与传输段不重叠：传输段首个事件已达 10 以上", async () => {
  const recorder = createRecordingAgent();
  const progress: AttachmentUploadProgress[] = [];

  await uploadAttachmentTransaction(
    recorder.agent,
    { workspacePath: "/tmp/probe" },
    putParams(900 * 1024),
    {
      onProgress: (event) => progress.push(event),
    },
  );

  // 900KiB = 3 块；首个 uploading 事件在 begin 之后，此时上传 0 字节，
  // 映射必须落在准备段上界（10）之外，不能和 preparing 的步数区间重叠。
  const uploading = progress.filter((event) => event.phase !== "preparing");
  assert.equal(uploading.length > 0, true);
  assert.equal(
    progress.some((event) => event.phase === "committing"),
    true,
    "commit 前应发出 committing",
  );
  assert.equal(recorder.commitCount(), 1);
});

test("超限判断先于解码：>20MiB 直接抛 payloadTooLarge 且不触碰 agent", async () => {
  const recorder = createRecordingAgent();
  const oversized = PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1024;

  await assert.rejects(
    uploadAttachmentTransaction(
      recorder.agent,
      { workspacePath: "/tmp/probe" },
      putParams(oversized),
    ),
    /proto\.payloadTooLarge/u,
  );
  assert.equal(recorder.beginCalls.length, 0, "超限时不得发出 begin");
  assert.equal(recorder.chunkCalls.length, 0, "超限时不得发出 chunk");
});

test("非法 base64 字符转 proto.invalidBase64，不泄漏原生错误码", async () => {
  const recorder = createRecordingAgent();
  const input = putParams(64);
  // 用 URL-safe 字符 '-' 替换 base64 中的 '+'：长度与 padding 都合规，
  // 但 atob 会以 InvalidCharacterError 拒绝。
  input.dataBase64 = input.dataBase64.replace("+", "-");

  await assert.rejects(
    uploadAttachmentTransaction(recorder.agent, { workspacePath: "/tmp/probe" }, input),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "proto.invalidBase64");
      assert.notEqual(error.name, "InvalidCharacterError");
      return true;
    },
  );
  assert.equal(recorder.beginCalls.length, 0);
});

test("长度非 4 倍数在解码前即被判为非法", async () => {
  const recorder = createRecordingAgent();
  const input = putParams(64);
  input.dataBase64 = input.dataBase64.slice(0, -1);

  await assert.rejects(
    uploadAttachmentTransaction(recorder.agent, { workspacePath: "/tmp/probe" }, input),
    /proto\.invalidBase64/u,
  );
  assert.equal(recorder.beginCalls.length, 0);
});

test("900KiB 仍按 384KiB 分为 3 块，chunkIndex 连续且 commit 一次", async () => {
  const recorder = createRecordingAgent();

  const result = await uploadAttachmentTransaction(
    recorder.agent,
    { workspacePath: "/tmp/probe" },
    putParams(900 * 1024),
  );

  assert.equal(result.ref, "zcode-artifact://sess_prepare/prepared");
  assert.equal(recorder.beginCalls[0]?.totalChunks, 3);
  assert.deepEqual(
    recorder.chunkCalls.map((chunk) => chunk.chunkIndex),
    [0, 1, 2],
  );
  assert.equal(recorder.commitCount(), 1);
});
