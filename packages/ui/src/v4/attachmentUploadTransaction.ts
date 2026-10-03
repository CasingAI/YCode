import { BufferWriter, serialize } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkResult,
  type V4AttachmentPutParams,
  type V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { computeAttachmentChecksum } from "@/v4/attachmentChecksum.js";

/** 384KiB 可被 3 整除，除末片外 base64 不含 padding；同时为两层 envelope 留足空间。 */
const ATTACHMENT_UPLOAD_CHUNK_BYTES = 384 * 1024;

interface AttachmentUploadAgent {
  attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams): Promise<V4AttachmentPutResult>;
  attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void>;
}

interface AttachmentUploadWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface AttachmentUploadProgress {
  /**
   * preparing 是首个 begin 往返之前的准备期（长度校验 → 解码 → checksum）。
   * 该阶段 uploadedBytes 承载「已完成的准备步数」而非字节数，消费方必须先按 phase 判别。
   */
  phase: "preparing" | "uploading" | "committing";
  uploadedBytes: number;
  totalBytes: number;
}

/** 准备期步数上限：长度校验、解码、checksum 三步。UI 据此把准备段映射到 0→10。 */
const ATTACHMENT_PREPARE_STEPS = 3;

export interface AttachmentUploadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AttachmentUploadProgress) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Attachment upload canceled");
  error.name = "AbortError";
  throw error;
}

function decodeBase64(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 由 base64 字符串长度推算解码后的字节数。
 *
 * 只做算术，不扫字符：字符合法性由随后的 atob 负责（它对非法字符抛
 * InvalidCharacterError）。原先这里还有一段逐字符校验循环，与 atob 的校验
 * 功能重叠，却让 20MiB 附件（≈2800 万字符）在主线程上多走一遍。保留
 * 长度计算是因为超限判断必须发生在解码之前——否则注定超限的 payload 仍要
 * 白做一次完整 atob。
 */
function decodedBase64ByteLength(dataBase64: string): number {
  if (dataBase64.length === 0) return 0;
  if (dataBase64.length % 4 !== 0) throw new Error("proto.invalidBase64");
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return (dataBase64.length / 4) * 3 - padding;
}

/** atob 的原生错误码不属于协议错误面，统一转成 proto.invalidBase64 保住既有分类。 */
function decodeBase64Strict(dataBase64: string): Uint8Array {
  try {
    return decodeBase64(dataBase64);
  } catch (error) {
    if (error instanceof Error && error.name === "InvalidCharacterError") {
      throw new Error("proto.invalidBase64");
    }
    throw error;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const callStackSafeChunk = 0x8000;
  for (let index = 0; index < bytes.length; index += callStackSafeChunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + callStackSafeChunk));
  }
  return btoa(binary);
}

function createUploadId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return `upload-${globalThis.crypto.randomUUID()}`;
  }
  const words = globalThis.crypto.getRandomValues(new Uint32Array(4));
  return `upload-${[...words].map((word) => word.toString(16).padStart(8, "0")).join("")}`;
}

/**
 * chunk 帧的固定开销上界：channel/method 头 + connectionId / uploadId / sessionId
 * / chunkIndex / workspace 等短字段。取保守值——这是上界估算而非精确值，
 * 真超出 maxFrameBytes 时发送路径仍会失败，这里只是提前挡住必然失败的帧。
 */
const CHUNK_FRAME_FIXED_OVERHEAD_BYTES = 4096;

/**
 * chunk 帧大小按算术估算，不做真实序列化。
 *
 * dataBase64 是帧里唯一的大字段，且 base64 全为 ASCII，字节数恰等于字符数；
 * 其余字段都是短字符串，用固定上界覆盖。原实现为量一个尺寸把整个 params
 * （含 512KB base64）真的 serialize 进一个用完即弃的 BufferWriter，随后真正
 * 发送时再序列化一遍——纯尺寸校验付了两倍序列化代价，且逐 chunk 重复。
 * begin / commit 的 params 不含大 payload、每次上传只跑一次，仍走精确序列化。
 */
function assertAttachmentChunkFrameFits(params: ZCodeAgentAttachmentChunkParams): void {
  if (
    CHUNK_FRAME_FIXED_OVERHEAD_BYTES + params.dataBase64.length >
    PROTOCOL_V4_LIMITS.maxFrameBytes
  ) {
    throw new Error("proto.frameTooLarge");
  }
}

/** 用 production ChannelClient 相同的 serializer 计量完整 method+args physical request。 */
function measureAttachmentChannelRequestBytes(method: string, params: unknown): number {
  const writer = new BufferWriter();
  // RequestType.Promise=100；max int id 比正常短生命周期 request id 更保守。
  serialize(writer, [100, 2_147_483_647, ServiceChannels.ZCodeAgent, method]);
  serialize(writer, [params]);
  return writer.buffer.byteLength;
}

function assertAttachmentChannelRequest(method: string, params: unknown): void {
  if (measureAttachmentChannelRequestBytes(method, params) > PROTOCOL_V4_LIMITS.maxFrameBytes) {
    throw new Error("proto.frameTooLarge");
  }
}

export async function uploadAttachmentTransaction(
  agent: AttachmentUploadAgent,
  workspace: AttachmentUploadWorkspace,
  input: V4AttachmentPutParams,
  options: AttachmentUploadOptions = {},
): Promise<V4AttachmentPutResult> {
  throwIfAborted(options.signal);
  // 超限判断先于解码：长度算完就能判定，为注定超限的 payload 省掉一次完整 atob。
  const decodedBytes = decodedBase64ByteLength(input.dataBase64);
  if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
    throw new Error("proto.payloadTooLarge");
  }
  options.onProgress?.({
    phase: "preparing",
    uploadedBytes: 0,
    totalBytes: decodedBytes,
  });
  const bytes = decodeBase64Strict(input.dataBase64);
  if (bytes.byteLength !== decodedBytes) throw new Error("proto.invalidBase64");
  options.onProgress?.({
    phase: "preparing",
    uploadedBytes: 1,
    totalBytes: decodedBytes,
  });
  const uploadId = createUploadId();
  const common = { ...workspace, sessionId: input.sessionId, uploadId };
  const totalChunks = Math.ceil(bytes.byteLength / ATTACHMENT_UPLOAD_CHUNK_BYTES);
  const checksum = await computeAttachmentChecksum(bytes);
  options.onProgress?.({
    phase: "preparing",
    uploadedBytes: ATTACHMENT_PREPARE_STEPS,
    totalBytes: decodedBytes,
  });
  const beginParams: ZCodeAgentAttachmentBeginParams = {
    ...common,
    fileName: input.fileName,
    mime: input.mime,
    totalBytes: bytes.byteLength,
    totalChunks,
    checksum,
  };
  assertAttachmentChannelRequest("attachmentBeginV4", beginParams);

  let began = false;
  try {
    throwIfAborted(options.signal);
    const begin = await agent.attachmentBeginV4(beginParams);
    began = true;
    if (begin.state === "committed") {
      options.onProgress?.({
        phase: "committing",
        uploadedBytes: bytes.byteLength,
        totalBytes: bytes.byteLength,
      });
      return { ref: begin.ref };
    }
    if (begin.nextChunkIndex > totalChunks) {
      throw new Error("fault.attachment.invalidServerProgress");
    }
    options.onProgress?.({
      phase: "uploading",
      uploadedBytes: Math.min(
        begin.nextChunkIndex * ATTACHMENT_UPLOAD_CHUNK_BYTES,
        bytes.byteLength,
      ),
      totalBytes: bytes.byteLength,
    });
    for (let chunkIndex = begin.nextChunkIndex; chunkIndex < totalChunks; chunkIndex += 1) {
      throwIfAborted(options.signal);
      const start = chunkIndex * ATTACHMENT_UPLOAD_CHUNK_BYTES;
      const chunkParams: ZCodeAgentAttachmentChunkParams = {
        ...common,
        chunkIndex,
        dataBase64: encodeBase64(
          bytes.subarray(start, Math.min(start + ATTACHMENT_UPLOAD_CHUNK_BYTES, bytes.length)),
        ),
      };
      assertAttachmentChunkFrameFits(chunkParams);
      const result = await agent.attachmentChunkV4(chunkParams);
      if (result.nextChunkIndex !== chunkIndex + 1) {
        throw new Error("fault.attachment.invalidServerProgress");
      }
      options.onProgress?.({
        phase: "uploading",
        uploadedBytes: Math.min((chunkIndex + 1) * ATTACHMENT_UPLOAD_CHUNK_BYTES, bytes.byteLength),
        totalBytes: bytes.byteLength,
      });
    }
    throwIfAborted(options.signal);
    options.onProgress?.({
      phase: "committing",
      uploadedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
    });
    const terminal = common satisfies ZCodeAgentAttachmentTerminalParams;
    assertAttachmentChannelRequest("attachmentCommitV4", terminal);
    return await agent.attachmentCommitV4(terminal);
  } catch (error) {
    if (began) {
      try {
        await agent.attachmentAbortV4(common);
      } catch (abortError) {
        logger.warn("[v4-attachment] failed to abort upload transaction", abortError);
      }
    }
    throw error;
  }
}
