// ============================================================
// Skill Tool - load reusable local instructions on demand
// ============================================================

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

export const SkillInputSchema = z.object({
  skill: z
    .string()
    .describe("The name of a skill from the available-skills list. Do not guess names."),
});

// args 从未进入 SkillPort；仅在 runtime 保留旧调用兼容，provider 不得继续暴露这个无效能力。
const SkillRuntimeCurrentInputSchema = SkillInputSchema.extend({
  args: z.string().optional(),
});

const LegacySkillInputSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
});

export const SkillRuntimeInputSchema = z
  .union([SkillRuntimeCurrentInputSchema, LegacySkillInputSchema])
  .transform((input) => ({
    args: input.args,
    skill: "skill" in input ? input.skill : input.name,
  }));

export type SkillInput = z.infer<typeof SkillInputSchema>;
export type SkillRuntimeInput = z.infer<typeof SkillRuntimeInputSchema>;

const skillInputJsonSchema = toToolJsonSchema(SkillInputSchema);
export const SkillInputJsonSchema = {
  ...skillInputJsonSchema,
  // 允许旧客户端抵达 runtime gate；args 没有 provider-visible 描述，也不会被 Skill 消费。
  additionalProperties: true,
};

export interface SkillStructuredOutput {
  name: string;
  content: string;
  baseDirectory: string;
  truncated: boolean;
}

export type SkillOutput = string | SkillStructuredOutput;

export const SkillStructuredOutputSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    baseDirectory: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const SkillOutputSchema = z.union([z.string(), SkillStructuredOutputSchema]);

export const SkillOutputJsonSchema = toToolJsonSchema(SkillOutputSchema);

export interface SkillToolCall {
  id: ToolCallId;
  name: "Skill";
  input: SkillInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface SkillToolResult {
  toolCallId: ToolCallId;
  output: SkillOutput;
  traceId: TraceId;
  durationMs: number;
}
