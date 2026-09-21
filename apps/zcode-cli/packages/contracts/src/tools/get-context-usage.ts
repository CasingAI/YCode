// ============================================================
// GetContextUsage tool - remaining context window snapshot
// ============================================================
// 口径与 auto compact 决策完全一致：used 优先取最近已提交 assistant 的
// provider usage 反推，否则本地估算；分母是扣除 output reserve 后的
// effective context window。见 docs/specs/session-context-tools.md。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const GET_CONTEXT_USAGE_TOOL_NAME = "GetContextUsage";

export const GetContextUsageInputSchema = z.object({}).strict();
export type GetContextUsageInput = z.infer<typeof GetContextUsageInputSchema>;
export const GetContextUsageInputJsonSchema = toToolJsonSchema(GetContextUsageInputSchema);

export const GetContextUsageOutputSchema = z
  .object({
    contextWindowTokens: z.number().int().nonnegative(),
    effectiveContextWindowTokens: z.number().int().nonnegative(),
    autocompactThresholdTokens: z.number().int().nonnegative(),
    usedTokens: z.number().int().nonnegative(),
    remainingTokens: z.number().int().nonnegative(),
    usedPercent: z.number(),
    remainingPercent: z.number(),
    tokenSource: z.enum(["estimate", "provider_usage"]),
  })
  .strict();
export type GetContextUsageOutput = z.infer<typeof GetContextUsageOutputSchema>;
export const GetContextUsageOutputJsonSchema = toToolJsonSchema(GetContextUsageOutputSchema);
