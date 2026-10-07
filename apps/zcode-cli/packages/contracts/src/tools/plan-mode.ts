// ============================================================
// Plan Mode Tools - EnterPlanMode switches mode, CreatePlan submits plan
// ============================================================

import { z } from "zod";
import type { CollaborationMode } from "../interfaces/session.port.js";
import type { TraceContext } from "../tracing/tracer.js";
import { toToolJsonSchema } from "./json-schema.js";

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const CREATE_PLAN_TOOL_NAME = "CreatePlan";

export const PLAN_MODE_MAX_PLAN_CHARS = 20_000;

// EnterPlanMode 无入参：切档意图本身就是全部信息，空对象 strict 校验。
export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;
export const EnterPlanModeInputJsonSchema = toToolJsonSchema(EnterPlanModeInputSchema);

export const EnterPlanModeOutputSchema = z
  .object({
    message: z.string().min(1).describe("Confirmation that plan mode was entered."),
    previousMode: z
      .enum(["plan", "readonly", "yolo"])
      .describe("Permission mode when EnterPlanMode ran."),
    mode: z.enum(["plan", "readonly", "yolo"]).describe("Current session mode (plan)."),
  })
  .strict();
export type EnterPlanModeOutput = z.infer<typeof EnterPlanModeOutputSchema>;
export const EnterPlanModeOutputJsonSchema = toToolJsonSchema(EnterPlanModeOutputSchema);

// plan file 需要保存最终提交的原始字符串；空白校验只看 trim 后内容，不在 schema transform 阶段改写 plan。
const CreatePlanPlanSchema = z
  .string()
  .min(1)
  .max(PLAN_MODE_MAX_PLAN_CHARS)
  .refine((value) => value.trim().length > 0, {
    message: "String must contain at least 1 character(s)",
  })
  .describe("The implementation plan to present to the user for approval.");

export const PLAN_MODE_MAX_TITLE_CHARS = 200;
export const PLAN_MODE_MAX_OVERVIEW_CHARS = 2_000;

const createPlanNonEmptyString = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, {
      message: "String must contain at least 1 character(s)",
    });

// title/overview 只被运行时落盘（frontmatter）与 UI 计划卡消费，见 docs/specs/session-plan-files.md。
// 必须为 schema 必填：缺失即在入参校验门报错并回给模型重试。可选 + 描述指引实测会被模型无视，
// 折叠卡随之落空——参数的意义靠校验闭环兑现，不靠模型自觉。
const CreatePlanTitleSchema = createPlanNonEmptyString(PLAN_MODE_MAX_TITLE_CHARS).describe(
  "Short plan title shown on the plan card. One line, no markdown decoration.",
);

const CreatePlanOverviewSchema = createPlanNonEmptyString(PLAN_MODE_MAX_OVERVIEW_CHARS).describe(
  "One to three sentences summarizing what the plan will do (and what it explicitly will not do, if relevant). Shown on the collapsed plan card; the full plan is only visible after the user clicks View.",
);

// 字段顺序是**产品事实**，不是书写习惯：toToolJsonSchema 按 shape 键序产出 provider 可见的
// properties/required，模型照这个顺序流式吐 JSON，UI 再从半截 JSON 里按字段名回收。plan 是整个
// 输出期最长的一段（实测可达上万字符），放在最前会让折叠计划卡在整段输出期都拿不到 title 与
// overview，只能拿计划正文的首行当标题渲染。所以短字段在前、长正文在后。
export const CreatePlanInputSchema = z
  .object({
    title: CreatePlanTitleSchema,
    overview: CreatePlanOverviewSchema,
    plan: CreatePlanPlanSchema,
  })
  .catchall(z.unknown());
export type CreatePlanInput = z.infer<typeof CreatePlanInputSchema>;
export const CreatePlanInputJsonSchema = toToolJsonSchema(CreatePlanInputSchema);

export const CreatePlanOutputSchema = z
  .object({
    plan: z.string().nullable().describe("The plan that was submitted."),
    // false = 已创建、待用户在计划卡上批准；不是失败。批准与执行统一由计划卡的「执行计划」按钮完成。
    approved: z.boolean().describe("False: plan created, waiting for user approval on the plan card."),
    previousMode: z
      .enum(["plan", "readonly", "yolo"])
      .describe("Permission mode when CreatePlan ran (record only, no mode switch)."),
    mode: z
      .enum(["plan", "readonly", "yolo"])
      .describe("Current session mode after CreatePlan ran (unchanged)."),
  })
  .strict();
export type CreatePlanOutput = z.infer<typeof CreatePlanOutputSchema>;
export const CreatePlanOutputJsonSchema = toToolJsonSchema(CreatePlanOutputSchema);

export interface SessionModeTransitionInput {
  toolCallId?: string;
  traceContext?: TraceContext;
}

export interface EnterPlanModeTransitionResult {
  mode: CollaborationMode;
  previousMode: CollaborationMode;
}

export interface SessionModePort {
  supportsPermissionFullAccess?(): boolean;
  /** mode 的派生查询；权限轴是单值，这里只是给既有调用点省一次比较。 */
  isPlanEnabled?(): boolean;
  isReadOnlyEnabled?(): boolean;
  getMode(): CollaborationMode;
  /**
   * 模型经 EnterPlanMode 切进 Plan。实现走既有档位写入点（applyRuntimeExecutionState，
   * source: "tool"），不新增写入路径；Goal 处于 active 时按既有规则先收口再切档。
   */
  enterPlanMode(input?: SessionModeTransitionInput): Promise<EnterPlanModeTransitionResult>;
}
