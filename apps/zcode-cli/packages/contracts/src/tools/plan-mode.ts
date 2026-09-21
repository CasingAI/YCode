// ============================================================
// Plan Mode Tools - plan approval flow
// ============================================================

import { z } from "zod";
import type { CollaborationMode } from "../interfaces/session.port.js";
import type { TraceContext } from "../tracing/tracer.js";
import { toToolJsonSchema } from "./json-schema.js";

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

export const PLAN_MODE_MAX_PLAN_CHARS = 20_000;

export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;
export const EnterPlanModeInputJsonSchema = toToolJsonSchema(EnterPlanModeInputSchema);

export const EnterPlanModeOutputSchema = z
  .object({
    message: z.string().min(1).describe("Confirmation that plan mode was entered."),
    previousMode: z
      .enum(["plan", "readonly", "yolo"])
      .describe("Session mode before EnterPlanMode ran."),
    mode: z.enum(["plan", "readonly", "yolo"]).describe("Current permission mode."),
  })
  .strict();
export type EnterPlanModeOutput = z.infer<typeof EnterPlanModeOutputSchema>;
export const EnterPlanModeOutputJsonSchema = toToolJsonSchema(EnterPlanModeOutputSchema);

export const ExitPlanModeAllowedPromptSchema = z
  .object({
    tool: z.enum(["Bash"]).describe("The tool this prompt applies to"),
    prompt: z
      .string()
      .describe('Semantic description of the action, e.g. "run tests", "install dependencies"'),
  })
  .strict();
export type ExitPlanModeAllowedPrompt = z.infer<typeof ExitPlanModeAllowedPromptSchema>;

// plan file 需要保存最终批准的原始字符串；空白校验只看 trim 后内容，不在 schema transform 阶段改写 plan。
const ExitPlanModePlanSchema = z
  .string()
  .min(1)
  .max(PLAN_MODE_MAX_PLAN_CHARS)
  .refine((value) => value.trim().length > 0, {
    message: "String must contain at least 1 character(s)",
  })
  .describe("The implementation plan to present to the user for approval.");

export const ExitPlanModeInputSchema = z
  .object({
    plan: ExitPlanModePlanSchema,
    allowedPrompts: z
      .array(ExitPlanModeAllowedPromptSchema)
      .optional()
      .describe(
        "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
      ),
  })
  .catchall(z.unknown());
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;
export const ExitPlanModeInputJsonSchema = toToolJsonSchema(ExitPlanModeInputSchema);

export const ExitPlanModeOutputSchema = z
  .object({
    plan: z.string().nullable().describe("The plan that was approved by the user."),
    approved: z.literal(true).describe("True when the user approved exiting plan mode."),
    previousMode: z
      .enum(["plan", "readonly", "yolo"])
      .describe("Previous permission mode."),
    mode: z
      .enum(["readonly", "yolo"])
      .describe("Current session mode after exiting plan mode."),
    allowedPrompts: z.array(ExitPlanModeAllowedPromptSchema).optional(),
  })
  .strict();
export type ExitPlanModeOutput = z.infer<typeof ExitPlanModeOutputSchema>;
export const ExitPlanModeOutputJsonSchema = toToolJsonSchema(ExitPlanModeOutputSchema);

export interface SessionModeTransitionInput {
  toolCallId?: string;
  traceContext?: TraceContext;
}

export interface EnterPlanModeTransitionResult {
  mode: CollaborationMode;
  previousMode: CollaborationMode;
}

export interface ExitPlanModeTransitionResult {
  mode: Exclude<CollaborationMode, "plan">;
  previousMode: CollaborationMode;
}

export interface SessionModePort {
  supportsPermissionFullAccess?(): boolean;
  /** mode 的派生查询；权限轴是单值，这里只是给既有调用点省一次比较。 */
  isPlanEnabled?(): boolean;
  isReadOnlyEnabled?(): boolean;
  getMode(): CollaborationMode;
  /** 进入计划模式前的档位，退出时还原；非计划模式期间为 undefined。 */
  getPrePlanMode(): Exclude<CollaborationMode, "plan"> | undefined;
  enterPlanMode(input?: SessionModeTransitionInput): Promise<EnterPlanModeTransitionResult>;
  exitPlanMode(input?: SessionModeTransitionInput): Promise<ExitPlanModeTransitionResult>;
}
