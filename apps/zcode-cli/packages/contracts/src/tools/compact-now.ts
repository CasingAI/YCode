// ============================================================
// CompactNow tool - request the same compaction as auto compact
// ============================================================
// 压缩本体不在工具内联执行：handler 只向 runtime 登记一次强制请求，
// 真正的压缩发生在 turn-loop 的 autoCompactIfNeeded 边界（trigger=Auto），
// 与上下文不足时的自动压缩完全同一条路径。见 docs/specs/session-context-tools.md。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const COMPACT_NOW_TOOL_NAME = "CompactNow";

export const CompactNowInputSchema = z
  .object({
    instructions: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional extra instructions guiding what the summary must preserve, for example '保留所有文件路径与关键决策'. Omit for a standard compaction summary.",
      ),
  })
  .strict();
export type CompactNowInput = z.infer<typeof CompactNowInputSchema>;
export const CompactNowInputJsonSchema = toToolJsonSchema(CompactNowInputSchema);

export const CompactNowOutputSchema = z
  .object({
    accepted: z.boolean(),
    message: z.string(),
  })
  .strict();
export type CompactNowOutput = z.infer<typeof CompactNowOutputSchema>;
export const CompactNowOutputJsonSchema = toToolJsonSchema(CompactNowOutputSchema);
