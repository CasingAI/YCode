import { z } from "zod";

export const CHATGPT_PLAN_HOST_CAPABILITY_ENV = "ZCODE_CHATGPT_PLAN_HOST_AVAILABLE";
export const CHATGPT_PLAN_PROVIDER_ID = "openai-chatgpt-plan";
export const CHATGPT_PLAN_API_ORIGIN = "https://api.openai.com/v1";
export const CHATGPT_PLAN_USAGE_URL = "https://chatgpt.com/settings/usage";

export const chatGPTAccountIdSchema = z.string().min(1).max(256);
export const chatGPTPlanModelSchema = z
  .object({
    slug: z.string().min(1).max(256),
    displayName: z.string().min(1).max(512),
  })
  .strict();
export const chatGPTPlanStateSchema = z
  .object({
    available: z.boolean(),
    pending: z.boolean(),
    activeAccountId: chatGPTAccountIdSchema.nullable(),
    accounts: z.array(
      z
        .object({
          id: chatGPTAccountIdSchema,
          label: z.string(),
          connected: z.boolean(),
          sharing: z.boolean(),
          errorCode: z.string().optional(),
        })
        .strict(),
    ),
    models: z.array(chatGPTPlanModelSchema),
    errorCode: z.string().optional(),
  })
  .strict();
export type ChatGPTPlanState = z.infer<typeof chatGPTPlanStateSchema>;
export type ChatGPTPlanModel = z.infer<typeof chatGPTPlanModelSchema>;

/** Host 私有模型桥：只有非敏感账户引用与 SSE 字节，永不返回认证头。 */
export const chatGPTPlanStreamRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("open"),
      streamId: z.string().uuid(),
      accountId: chatGPTAccountIdSchema,
      body: z.string().max(32 * 1024 * 1024),
    })
    .strict(),
  z.object({ operation: z.literal("read"), streamId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("close"), streamId: z.string().uuid() }).strict(),
]);
export const chatGPTPlanStreamResponseSchema = z
  .object({
    done: z.boolean(),
    data: z
      .string()
      .max(256 * 1024)
      .optional(),
    errorCode: z.string().optional(),
  })
  .strict();
export type ChatGPTPlanStreamRequest = z.infer<typeof chatGPTPlanStreamRequestSchema>;
export type ChatGPTPlanStreamResponse = z.infer<typeof chatGPTPlanStreamResponseSchema>;

export type ChatGPTPlanTransport = (
  accountId: string,
  body: string,
  signal?: AbortSignal,
) => Promise<Response>;
