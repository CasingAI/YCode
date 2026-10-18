import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TraceId } from "@zcode/shared";
import {
  CHATGPT_PLAN_API_ORIGIN,
  chatGPTPlanStreamRequestSchema,
  type ChatGPTPlanStreamRequest,
  type ChatGPTPlanStreamResponse,
} from "@zcode/shared";
import type { ChatGPTPlanOwner } from "./service.js";
import {
  buildChatGPTPlanRequest,
  ChatGPTPlanError,
  safeChatGPTErrorCode,
  validateChatGPTPlanStream,
} from "./responses.js";

const RECENT_STREAM_ID_LIMIT = 4096;

interface StreamEntry {
  traceId?: TraceId;
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  remainder?: Uint8Array;
  reading: boolean;
  release: () => void;
}

/** 每条 stdio 连接独占实例；stream ID 不能跨 client 读取，也不参与手机事件重放。 */
export class ChatGPTPlanStreamBridge {
  private readonly logger = createServiceLogger("chatgpt-plan-responses");
  private readonly streams = new Map<string, StreamEntry>();
  private readonly admitted = new Set<string>();
  constructor(
    private readonly owner: ChatGPTPlanOwner,
    private readonly fetchImpl: typeof fetch,
  ) {}
  async handle(
    raw: ChatGPTPlanStreamRequest,
    traceId?: TraceId,
  ): Promise<ChatGPTPlanStreamResponse> {
    const input = chatGPTPlanStreamRequestSchema.parse(raw);
    if (input.operation === "open" && this.admitted.has(input.streamId))
      return { done: true, errorCode: "duplicate_stream" };
    try {
      if (input.operation === "close") {
        this.remember(input.streamId);
        this.close(input.streamId);
        return { done: true };
      }
      if (input.operation === "open") {
        if (this.streams.size >= 32) throw new ChatGPTPlanError("stream_admission_failed");
        this.remember(input.streamId);
        const controller = new AbortController();
        const entry: StreamEntry = {
          traceId,
          controller,
          reading: false,
          release: this.owner.trackRequest(input.accountId, controller),
        };
        this.streams.set(input.streamId, entry);
        const body = buildChatGPTPlanRequest(JSON.parse(input.body));
        const response = await this.owner.withAccount(
          input.accountId,
          async (account) => {
            if (!account.models.some((model) => model.slug === body.model))
              throw new ChatGPTPlanError("model_not_available");
            this.logger.info(traceId, "模型请求开始", {
              streamId: input.streamId,
              modelId: body.model,
            });
            return this.fetchImpl(`${CHATGPT_PLAN_API_ORIGIN}/responses`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${account.tokens!.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
              redirect: "error",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]),
            });
          },
          controller.signal,
        );
        if (controller.signal.aborted) throw new ChatGPTPlanError("request_cancelled");
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new ChatGPTPlanError(`responses_http_${response.status}`);
        }
        if (!response.headers.get("content-type")?.includes("text/event-stream")) {
          await response.body.cancel();
          throw new ChatGPTPlanError("invalid_stream_content_type");
        }
        const tools = body.tools as Array<{ tools: Array<{ name: string }> }> | undefined;
        entry.reader = validateChatGPTPlanStream(
          response.body,
          new Set(tools?.flatMap((namespace) => namespace.tools.map((tool) => tool.name)) ?? []),
        ).getReader();
        return { done: false };
      }
      const entry = this.streams.get(input.streamId);
      if (!entry?.reader || entry.reading) throw new ChatGPTPlanError("stream_not_available");
      entry.reading = true;
      try {
        const chunk = entry.remainder
          ? { done: false, value: entry.remainder }
          : await entry.reader.read();
        if (chunk.done) {
          this.logger.info(entry.traceId, "模型请求完成", { streamId: input.streamId });
          this.close(input.streamId);
          return { done: true };
        }
        const data = chunk.value!;
        const part = data.subarray(0, 64 * 1024);
        entry.remainder =
          data.byteLength > part.byteLength ? data.subarray(part.byteLength) : undefined;
        return { done: false, data: Buffer.from(part).toString("base64") };
      } finally {
        entry.reading = false;
      }
    } catch (error) {
      this.close(input.streamId);
      const errorCode = safeChatGPTErrorCode(error);
      const log =
        errorCode === "request_cancelled"
          ? this.logger.info
          : errorCode === "reauthentication_required"
            ? this.logger.error
            : this.logger.warn;
      log(traceId, "模型请求终止", { streamId: input.streamId, errorCode });
      return { done: true, errorCode };
    }
  }
  private remember(id: string): void {
    this.admitted.add(id);
    // 仅保留有界的近期幂等记录；活跃流永不淘汰，也不按累计请求数停止长程任务。
    for (const previous of this.admitted) {
      if (this.admitted.size <= RECENT_STREAM_ID_LIMIT) break;
      if (previous !== id && !this.streams.has(previous)) this.admitted.delete(previous);
    }
  }
  private close(id: string): void {
    const entry = this.streams.get(id);
    this.streams.delete(id);
    if (entry) {
      entry.controller.abort();
      void entry.reader?.cancel().catch(() => {});
      entry.release();
    }
  }
  dispose(): void {
    for (const id of this.streams.keys()) this.close(id);
    this.admitted.clear();
  }
}
