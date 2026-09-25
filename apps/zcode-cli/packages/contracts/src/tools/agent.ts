// ============================================================
// Agent Tool - Subagent orchestration tool
// ============================================================
// 普通 Agent 只能前台执行；历史 async 输出类型保留用于旧会话读取。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import type { ModelUsage } from "../model/index.js";
import { toToolJsonSchema } from "./json-schema.js";

export const AgentType = {
  GeneralPurpose: "general-purpose",
  Explore: "Explore",
} as const;

export type AgentType = string;

export const AgentInputSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .optional()
    .describe("The type of specialized agent to use for this task"),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

// 旧客户端可能仍发送 run_in_background；它不进入 provider-visible schema，
// 但会先被 runtime schema 保留下来，再由 Agent handler 明确拒绝 true。
export const AgentRuntimeInputSchema = AgentInputSchema.extend({
  run_in_background: z.boolean().optional(),
});

export type AgentRuntimeInput = z.infer<typeof AgentRuntimeInputSchema>;

const agentInputJsonSchema = toToolJsonSchema(AgentInputSchema);
export const AgentInputJsonSchema = {
  ...agentInputJsonSchema,
  // 允许旧客户端抵达 runtime gate；字段本身没有 provider-visible 描述。
  additionalProperties: true,
};

export interface AgentTextContentBlock {
  type: "text";
  text: string;
}

export type AgentTerminalStatus = "completed" | "failed" | "cancelled";

export interface AgentCompletedOutput {
  status: "completed";
  agentId: string;
  childSessionId?: string;
  canContinue?: boolean;
  contextReset?: boolean;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalReasoningDurationMs?: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
}

export interface AgentFailedOutput {
  status: "failed";
  agentId: string;
  childSessionId?: string;
  canContinue?: boolean;
  contextReset?: boolean;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  error: string;
  /**
   * 失败/取消终态没有 child TurnResult。回读不到子会话事件时缺席表示「未知」；
   * 写成 0 会被冷恢复当成真实统计展示。
   */
  totalToolUseCount?: number;
  totalReasoningDurationMs?: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
}

export interface AgentCancelledOutput {
  status: "cancelled";
  agentId: string;
  childSessionId?: string;
  canContinue?: boolean;
  contextReset?: boolean;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  error?: string;
  /** 同 AgentFailedOutput.totalToolUseCount：未知时缺席，不填 0。 */
  totalToolUseCount?: number;
  totalReasoningDurationMs?: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
}

export type AgentTerminalOutput = AgentCompletedOutput | AgentFailedOutput | AgentCancelledOutput;

/** @deprecated 仅用于读取旧会话中的 async_launched 结果。 */
export interface AgentBackgroundedOutput {
  status: "async_launched";
  isAsync: true;
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  childSessionId: string;
  backgroundTaskId: string;
  outputFile: string;
  canReadOutputFile: boolean;
}

export type AgentOutput = AgentTerminalOutput | AgentBackgroundedOutput;

export const AgentTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const agentTerminalFields = {
  agentId: z.string(),
  childSessionId: z.string().optional(),
  canContinue: z.boolean().optional(),
  contextReset: z.boolean().optional(),
  agentType: z.string(),
  description: z.string(),
  prompt: z.string(),
  content: z.array(AgentTextContentBlockSchema),
  totalToolUseCount: z.number().int().nonnegative(),
  totalReasoningDurationMs: z.number().int().nonnegative().optional(),
  totalDurationMs: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  usage: z.custom<ModelUsage>().optional(),
};

/**
 * 失败/取消的用量字段可选：这两条路径没有 child TurnResult，
 * 回读不到子会话事件时是「未知」而不是 0。
 */
const agentIncompleteTerminalFields = {
  ...agentTerminalFields,
  totalToolUseCount: z.number().int().nonnegative().optional(),
};

export const AgentCompletedOutputSchema = z
  .object({
    status: z.literal("completed"),
    ...agentTerminalFields,
  })
  .strict();

export const AgentFailedOutputSchema = z
  .object({
    status: z.literal("failed"),
    ...agentIncompleteTerminalFields,
    error: z.string(),
  })
  .strict();

export const AgentCancelledOutputSchema = z
  .object({
    status: z.literal("cancelled"),
    ...agentIncompleteTerminalFields,
    error: z.string().optional(),
  })
  .strict();

export const AgentTerminalOutputSchema = z.union([
  AgentCompletedOutputSchema,
  AgentFailedOutputSchema,
  AgentCancelledOutputSchema,
]);
/** @deprecated 仅用于旧会话 hydration。 */
export const AgentBackgroundedOutputSchema = z
  .object({
    status: z.literal("async_launched"),
    isAsync: z.literal(true),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    childSessionId: z.string(),
    backgroundTaskId: z.string(),
    outputFile: z.string(),
    canReadOutputFile: z.boolean(),
  })
  .strict();

export const AgentOutputSchema = z.union([
  AgentTerminalOutputSchema,
  AgentBackgroundedOutputSchema,
]);

export const AgentOutputJsonSchema = toToolJsonSchema(AgentOutputSchema);

export interface AgentToolCall {
  id: ToolCallId;
  name: "Agent";
  input: AgentInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface AgentToolResult {
  toolCallId: ToolCallId;
  output: AgentOutput;
  traceId: TraceId;
  durationMs: number;
}

export const AgentErrorCode = {
  SUBAGENT_UNAVAILABLE: "agent_subagent_unavailable",
  BACKGROUND_UNAVAILABLE: "agent_background_unavailable",
  UNKNOWN_AGENT_TYPE: "agent_unknown_type",
  CHILD_RUNTIME_FAILED: "agent_child_runtime_failed",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
