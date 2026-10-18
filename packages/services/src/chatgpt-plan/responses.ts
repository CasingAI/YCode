import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const functionTool = z
  .object({
    type: z.literal("function"),
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    description: z.string().optional(),
    parameters: object,
    strict: z.boolean().nullable().optional(),
  })
  .strict();
const inputItem = object.refine((item) => {
  const type = item.type;
  if (
    type !== undefined &&
    !["message", "function_call", "function_call_output", "reasoning", "compaction"].includes(
      String(type),
    )
  )
    return false;
  const content = item.content ?? (type === "function_call_output" ? item.output : undefined);
  if (!Array.isArray(content)) return true;
  return content.every(
    (part) =>
      part &&
      typeof part === "object" &&
      ["input_text", "output_text", "input_image", "input_file", "refusal"].includes(
        String(part.type),
      ) &&
      !("file_id" in part),
  );
}, "Unsupported ChatGPT history item");
const requestSchema = z.object({
  model: z.string().min(1).max(256),
  input: z.array(inputItem),
  instructions: z.string().optional(),
  reasoning: z
    .object({
      effort: z.string().optional(),
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
    })
    .strict()
    .optional(),
  text: z
    .object({ format: object.optional(), verbosity: z.enum(["low", "medium", "high"]).optional() })
    .strict()
    .optional(),
  tools: z.array(functionTool).optional(),
  tool_choice: z.enum(["auto", "none", "required"]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  include: z.array(z.literal("reasoning.encrypted_content")).optional(),
  prompt_cache_key: z.string().optional(),
});

/** 专用白名单：不把普通 API 的 options/认证参数透传到订阅通道。 */
export function buildChatGPTPlanRequest(raw: unknown): Record<string, unknown> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new ChatGPTPlanError("unsupported_request_content");
  const { tools, input, ...options } = parsed.data;
  return {
    ...options,
    input: input.map((item) => (item.role === "system" ? { ...item, role: "developer" } : item)),
    store: false,
    stream: true,
    ...(tools?.length ? { tools: [{ type: "namespace", name: "ycode", tools }] } : {}),
  };
}

export class ChatGPTPlanError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChatGPTPlanError";
  }
}

export type ChatGPTPlanNetworkEndpoint = "oauth" | "api";
export type ChatGPTPlanNetworkRoute = "direct" | "proxy" | "invalid";

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current) && chain.length < 8) {
    chain.push(current);
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return chain;
}

function errorProperty(error: unknown, key: string): unknown {
  return error && typeof error === "object" && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

/** Only return machine-generated error codes; never expose a raw error message or URL in logs. */
export function safeChatGPTNetworkCauseCode(error: unknown): string | undefined {
  for (const candidate of errorChain(error)) {
    const code = errorProperty(candidate, "code");
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  return undefined;
}

function readHttpStatus(error: unknown): number | undefined {
  for (const candidate of errorChain(error)) {
    const status = errorProperty(candidate, "status") ?? errorProperty(candidate, "statusCode");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      return status;
    const response = errorProperty(candidate, "response");
    const responseStatus = errorProperty(response, "status");
    if (
      typeof responseStatus === "number" &&
      Number.isInteger(responseStatus) &&
      responseStatus >= 100 &&
      responseStatus <= 599
    )
      return responseStatus;
  }
  return undefined;
}

/** Convert low-level transport/OIDC failures into safe, stable codes for logs and Renderer state. */
export function diagnoseChatGPTPlanNetworkError(
  error: unknown,
  context: { endpoint: ChatGPTPlanNetworkEndpoint; route?: ChatGPTPlanNetworkRoute },
): ChatGPTPlanError {
  if (error instanceof ChatGPTPlanError) return error;
  const chain = errorChain(error);
  const names = chain.map((candidate) => errorProperty(candidate, "name"));
  const codes = chain
    .map((candidate) => errorProperty(candidate, "code"))
    .filter((code): code is string => typeof code === "string");

  if (names.includes("AbortError")) return new ChatGPTPlanError("request_cancelled");
  if (context.route === "invalid") return new ChatGPTPlanError("proxy_configuration_invalid");

  if (
    codes.some((code) =>
      /^(CERT_|ERR_TLS|ERR_SSL|SELF_SIGNED_CERT|UNABLE_TO_VERIFY|DEPTH_ZERO)/.test(code),
    )
  )
    return new ChatGPTPlanError("tls_certificate_failed");

  if (
    names.includes("TimeoutError") ||
    codes.some((code) =>
      [
        "ETIMEDOUT",
        "ESOCKETTIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(code),
    )
  )
    return new ChatGPTPlanError("connection_timeout");

  if (
    codes.some((code) =>
      ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "ENODATA", "EAI_NODATA"].includes(code),
    )
  )
    return new ChatGPTPlanError("dns_resolution_failed");

  if (
    context.route === "proxy" &&
    codes.some((code) =>
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "EPIPE",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT",
      ].includes(code),
    )
  )
    return new ChatGPTPlanError("proxy_connection_failed");

  const status = readHttpStatus(error);
  if (status && status >= 400) {
    return new ChatGPTPlanError(
      context.endpoint === "oauth" ? `oauth_endpoint_http_${status}` : `http_status_${status}`,
    );
  }

  if (codes.some((code) => code.startsWith("OAUTH_"))) {
    if (
      codes.some((code) =>
        [
          "OAUTH_INVALID_RESPONSE",
          "OAUTH_METADATA_INVALID",
          "OAUTH_RESPONSE_IS_NOT_CONFORM",
        ].includes(code),
      )
    )
      return new ChatGPTPlanError("oauth_endpoint_response_invalid");
    return new ChatGPTPlanError("oauth_protocol_error");
  }

  if (
    names.some((name) => name === "ResponseBodyError" || name === "SyntaxError") ||
    codes.some((code) => ["ERR_INVALID_JSON", "OAUTH_METADATA_INVALID"].includes(code))
  )
    return new ChatGPTPlanError("oauth_endpoint_response_invalid");

  return new ChatGPTPlanError(
    context.endpoint === "oauth" ? "oauth_network_request_failed" : "network_request_failed",
  );
}

/** 不把供应商原始异常、HTTP body 或 token response 带出可信 Host。 */
export function safeChatGPTErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "request_cancelled";
  return error instanceof ChatGPTPlanError && /^[a-zA-Z0-9_-]{1,100}$/.test(error.code)
    ? error.code
    : "chatgpt_plan_unavailable";
}

export function validateChatGPTPlanStream(
  source: ReadableStream<Uint8Array>,
  allowedTools?: ReadonlySet<string>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "";
  let completed = false;
  const calls = new Map<
    string,
    { callId: string; name: string; arguments: string; done: boolean }
  >();
  const bufferedTools: Uint8Array[] = [];
  let bufferedBytes = 0;

  const validateFrame = (frame: string) => {
    const data = frame
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return false;
    let event: Record<string, unknown>;
    try {
      event = object.parse(JSON.parse(data));
    } catch {
      throw new ChatGPTPlanError("invalid_stream_event");
    }
    if (completed) throw new ChatGPTPlanError("event_after_completed");
    if (event.type === "response.failed" || event.type === "error") {
      const response = event.response as { error?: { code?: string } } | undefined;
      const error = event.error as { code?: string } | undefined;
      const code = response?.error?.code ?? error?.code ?? event.code;
      throw new ChatGPTPlanError(
        typeof code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? code : "response_failed",
      );
    }
    if (event.type === "response.incomplete") throw new ChatGPTPlanError("response_incomplete");
    const item = event.item as Record<string, unknown> | undefined;
    let toolEvent = false;
    if (event.type === "response.output_item.added" && item?.type === "function_call") {
      if (
        typeof item.id !== "string" ||
        typeof item.call_id !== "string" ||
        !item.call_id ||
        typeof item.name !== "string" ||
        !item.name ||
        calls.has(item.id) ||
        (allowedTools && !allowedTools.has(item.name))
      )
        throw new ChatGPTPlanError("invalid_tool_call");
      calls.set(item.id, {
        callId: item.call_id,
        name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : "",
        done: false,
      });
      toolEvent = true;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const call = calls.get(String(event.item_id));
      if (!call || call.done || typeof event.delta !== "string")
        throw new ChatGPTPlanError("invalid_tool_arguments");
      call.arguments += event.delta;
      toolEvent = true;
    }
    if (event.type === "response.function_call_arguments.done") toolEvent = true;
    if (event.type === "response.output_item.done" && item?.type === "function_call") {
      const call = calls.get(String(item.id));
      if (
        !call ||
        call.done ||
        call.callId !== item.call_id ||
        call.name !== item.name ||
        call.arguments !== item.arguments
      )
        throw new ChatGPTPlanError("invalid_tool_call");
      try {
        object.parse(JSON.parse(call.arguments));
      } catch {
        throw new ChatGPTPlanError("invalid_tool_arguments");
      }
      call.done = true;
      toolEvent = true;
    }
    if (event.type === "response.completed") {
      const response = event.response as
        | { status?: string; output?: Array<Record<string, unknown>> }
        | undefined;
      if (response?.status !== "completed") throw new ChatGPTPlanError("invalid_completed_event");
      const callIds = new Set<string>();
      for (const item of response.output ?? []) {
        if (item.type !== "function_call") continue;
        if (
          typeof item.call_id !== "string" ||
          !item.call_id ||
          callIds.has(item.call_id) ||
          typeof item.name !== "string" ||
          !item.name ||
          typeof item.arguments !== "string"
        ) {
          throw new ChatGPTPlanError("invalid_tool_call");
        }
        const streamed = calls.get(String(item.id));
        if (
          !streamed?.done ||
          streamed.callId !== item.call_id ||
          streamed.name !== item.name ||
          streamed.arguments !== item.arguments
        )
          throw new ChatGPTPlanError("invalid_tool_call");
        callIds.add(item.call_id);
        try {
          object.parse(JSON.parse(item.arguments));
        } catch {
          throw new ChatGPTPlanError("invalid_tool_arguments");
        }
      }
      if (callIds.size !== calls.size) throw new ChatGPTPlanError("invalid_tool_call");
      completed = true;
    }
    return toolEvent;
  };
  const flushFrames = (controller: TransformStreamDefaultController<Uint8Array>) => {
    let match: RegExpExecArray | null;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const toolEvent = validateFrame(frame);
      const encoded = encoder.encode(`${frame}\n\n`);
      // Core 会在 final tool_call 到达时预执行工具；因此必须等 Host 已验证 completed 才下发任何工具事件。
      if (toolEvent) {
        bufferedBytes += encoded.byteLength;
        if (bufferedBytes > 16 * 1024 * 1024) throw new ChatGPTPlanError("tool_stream_too_large");
        bufferedTools.push(encoded);
      } else {
        if (completed) {
          for (const toolFrame of bufferedTools) controller.enqueue(toolFrame);
          bufferedTools.length = 0;
        }
        controller.enqueue(encoded);
      }
    }
    if (pending.length > 8 * 1024 * 1024) throw new ChatGPTPlanError("stream_frame_too_large");
  };
  return source.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        flushFrames(controller);
      },
      flush(controller) {
        pending += decoder.decode();
        flushFrames(controller);
        // 不接受未封闭的 frame，EOF 与成功终止是不同事实。
        if (pending.trim() || !completed) throw new ChatGPTPlanError("stream_interrupted");
      },
    }),
  );
}
