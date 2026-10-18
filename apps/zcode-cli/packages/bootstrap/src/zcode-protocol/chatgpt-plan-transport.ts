import { getCurrentModelInvocationContext } from "@zcode/contracts";
import { createChatGPTPlanRequestError } from "./chatgpt-plan-error.js";
import { randomUUID } from "node:crypto";
import {
  chatGPTPlanStreamResponseSchema,
  zcodeProtocolMethods,
  type ChatGPTPlanTransport,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";
const CHATGPT_PLAN_RPC_TIMEOUT_MS = 180_000;

/** 拉取式 stdio bridge：不传 token/URL/header，不重试已发出的模型请求。 */
export function createChatGPTPlanTransport(
  context: Pick<ZCodeProtocolAgentServerContext, "requestClient">,
): ChatGPTPlanTransport {
  return async (accountId, body, signal) => {
    const traceContext = getCurrentModelInvocationContext()?.traceContext;
    const trace = traceContext ? protocolTraceFromTraceContext(traceContext) : undefined;
    const streamId = randomUUID();
    let closed = false;
    const call = async (operation: "open" | "read" | "close") => {
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionChatGPTPlanStream,
        operation === "open" ? { operation, streamId, accountId, body } : { operation, streamId },
        chatGPTPlanStreamResponseSchema,
        {
          timeoutMs: CHATGPT_PLAN_RPC_TIMEOUT_MS,
          ...(trace ? { trace } : {}),
          ...(operation === "close" ? {} : { signal }),
        },
      );
      if (result.errorCode) throw createChatGPTPlanRequestError(result.errorCode);
      return result;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", close);
      void call("close").catch(() => {});
    };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", close, { once: true });
    try {
      await call("open");
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await call("read");
            if (result.data) controller.enqueue(Buffer.from(result.data, "base64"));
            if (result.done) {
              close();
              controller.close();
            }
          } catch (error) {
            close();
            controller.error(error);
          }
        },
        cancel: close,
      });
      // generateText 仍沿用现有 SDK JSON 解析，但公网请求始终是 SSE，且已在 Host 验证 completed。
      if (JSON.parse(body).stream !== true) {
        const text = await new Response(stream).text();
        for (const frame of text.split(/\n\n/)) {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data || data === "[DONE]") continue;
          const event = JSON.parse(data);
          if (event.type === "response.completed")
            return new Response(JSON.stringify(event.response), {
              headers: { "Content-Type": "application/json" },
            });
        }
        throw new Error("stream_interrupted");
      }
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    } catch (error) {
      close();
      throw error;
    }
  };
}
