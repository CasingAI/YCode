// ============================================================
// Compact tool - request the same compaction as auto compact
// ============================================================
// 压缩本体不在工具内联执行：handler 只向 runtime 登记一次强制请求，
// 真正的压缩发生在 turn-loop 的 autoCompactIfNeeded 边界（trigger=Auto），
// 与上下文不足时的自动压缩完全同一条路径。见 docs/specs/session-context-tools.md。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const COMPACT_TOOL_NAME = "Compact";
export const COMPACT_TOOL_ALIASES = ["CompactNow"] as const;

/** @deprecated Use COMPACT_TOOL_NAME. */
export const COMPACT_NOW_TOOL_NAME = COMPACT_TOOL_ALIASES[0];

export const CompactInputSchema = z
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
export type CompactInput = z.infer<typeof CompactInputSchema>;
export const CompactInputJsonSchema = toToolJsonSchema(CompactInputSchema);

export const CompactOutputSchema = z
  .object({
    failed: z.boolean(),
  })
  .strict();
export type CompactOutput = z.infer<typeof CompactOutputSchema>;
export const CompactOutputJsonSchema = toToolJsonSchema(CompactOutputSchema);

/** @deprecated Use CompactInputSchema. */
export const CompactNowInputSchema = CompactInputSchema;
/** @deprecated Use CompactInput. */
export type CompactNowInput = CompactInput;
/** @deprecated Use CompactInputJsonSchema. */
export const CompactNowInputJsonSchema = CompactInputJsonSchema;
/** @deprecated Use CompactOutputSchema. */
export const CompactNowOutputSchema = CompactOutputSchema;
/** @deprecated Use CompactOutput. */
export type CompactNowOutput = CompactOutput;
/** @deprecated Use CompactOutputJsonSchema. */
export const CompactNowOutputJsonSchema = CompactOutputJsonSchema;
