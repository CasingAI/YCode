// ============================================================
// Agent Tool Handler
// ============================================================

import {
  AgentErrorCode,
  AgentInputJsonSchema,
  AgentOutputJsonSchema,
  AgentOutputSchema,
  AgentRuntimeInputSchema,
  AgentType,
  CoreErrorType,
  createCoreError,
  type AgentOutput,
  type AgentRuntimeInput,
  type TraceContext,
} from "@zcode/contracts";
import { TASK_TOOL_NAME } from "../compat.js";
import type { ToolEntry, ToolHandler } from "../types.js";
import { formatAgentProfilesForPrompt, type AgentProfile } from "../../subagent/profile.js";

const MAX_AGENT_MODEL_BYTES = 120_000;

/**
 * Dynamic Workflow 会话工具开关也管**工具描述**：
 * 关闭时十个工具不注册，但这条 bullet 仍在 Agent 的 provider 描述里写着「CreateWorkflow
 * 是强制的」，于是模型被指向一个根本不存在的工具，只会白白撞一次 tool_not_found。
 * 缺省 true：TUI、headless 与既有调用方（包括模块加载期烘焙的 AGENT_PROVIDER_DESCRIPTION）
 * 行为不变，只有显式 false 才抹掉这一行。
 */
function buildAgentProviderDescription(
  options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    dynamicWorkflowEnabled?: boolean;
  } = {},
): string {
  const agentList = formatAgentProfilesForPrompt(options.profiles ?? [], {
    embeddedSearchEnabled: options.embeddedSearchEnabled,
  });

  return [
    "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.",
    "",
    agentList,
    "",
    "When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.",
    "",
    "## When to use",
    "",
    "Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.",
    "",
    "- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.",
    "- A new Agent call starts fresh, so the prompt must be self-contained.",
    "- The parent turn waits for the agent to finish; the returned agentId remains the stable handle for SendMessage continuation after any terminal status.",
    "- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.",
    // 只保留「用户点名工作流」这一种情形：工作流一律由用户显式请求触发，与系统提示词其余
    // 部分一致。不能把「结果层层喂给下一步的多代理编排」也划给 CreateWorkflow，
    // 那等于让模型在用户没开口时自行选择工作流。
    ...(options.dynamicWorkflowEnabled === false
      ? []
      : [
          '- If the user explicitly asks for a workflow ("use a workflow", "使用 workflow", "用工作流", or any phrasing naming workflow/工作流 as the means), the CreateWorkflow tool is mandatory: do not use this tool instead, however small the task.',
        ]),
  ].join("\n");
}

const AGENT_PROVIDER_DESCRIPTION = buildAgentProviderDescription();

function formatAgentOutputForModel(output: unknown): string {
  const parsed = AgentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }

  const data = parsed.data as AgentOutput;
  if (data.status === "async_launched") {
    // 旧会话可能仍包含 async_launched；新执行路径不会再产生该结果。
    return "Legacy background agent result received. Use TaskOutput to inspect the historical task.";
  }

  const childText = data.content.map((block) => block.text).join("\n");
  const childContent =
    childText.trim().length > 0
      ? [childText]
      : [`(Subagent ${data.status} but returned no output.)`];
  const usageLines = [
    ...(data.totalTokens === undefined ? [] : [`subagent_tokens: ${data.totalTokens}`]),
    `tool_uses: ${data.totalToolUseCount}`,
    `duration_ms: ${data.totalDurationMs}`,
  ];
  return [
    ...childContent,
    `status: ${data.status}`,
    `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)`,
    ...(data.contextReset ? ["contextReset: true (continuation will start a fresh child context)"] : []),
    ...(data.status === "failed" || data.status === "cancelled"
      ? [data.error ?? `Agent ${data.status}.`]
      : []),
    `<usage>${usageLines.join("\n")}</usage>`,
  ].join("\n");
}

const agentHandler: ToolHandler = async (input, context) => {
  const parsed = AgentRuntimeInputSchema.parse(input) as AgentRuntimeInput;
  const agentType = parsed.subagent_type ?? AgentType.GeneralPurpose;

  if (parsed.run_in_background === true) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Background execution is not supported for Agent subagents. Run it in the foreground.",
      {
        context: {
          code: AgentErrorCode.BACKGROUND_UNAVAILABLE,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: true,
      },
    );
  }

  if (!context.subagentPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SubagentPort is not configured for Agent tool",
      {
        context: {
          code: AgentErrorCode.SUBAGENT_UNAVAILABLE,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: false,
      },
    );
  }

  const request = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    parentToolCallId: context.toolCallId,
    agentType,
    description: parsed.description,
    prompt: parsed.prompt,
    workspaceIdentity: context.workspaceIdentity,
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext,
  };
  return context.subagentPort.run(request, {
    signal: context.abortSignal,
    ...(context.model ? { model: context.model } : {}),
    ...(context.subagentModelOverride ? { modelOverride: context.subagentModelOverride } : {}),
  });
};

export const agentToolEntry: ToolEntry = {
  capability: "Launch a profile-backed subagent in the foreground",
  metadata: {
    name: "Agent",
    description: AGENT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: MAX_AGENT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: agentHandler,
  formatModelContent: formatAgentOutputForModel,
  inputSchema: AgentInputJsonSchema,
  outputSchema: AgentOutputJsonSchema,
  runtimeInputSchema: AgentRuntimeInputSchema,
  runtimeOutputSchema: AgentOutputSchema,
  permission: {
    permission: "subagent",
    reason:
      "Agent launches a child runtime; child tool calls are separately constrained and approved",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_AGENT_MODEL_BYTES,
    maxModelBytes: MAX_AGENT_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_AGENT_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    joinOnCancel: true,
    userVisibleMessage: "Agent was cancelled before the subagent returned its findings",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const taskToolEntry: ToolEntry = {
  ...agentToolEntry,
  capability: "Claude Code-compatible alias for launching a ZCode subagent",
  metadata: {
    ...agentToolEntry.metadata,
    name: TASK_TOOL_NAME,
    providerVisible: false,
    description: [
      "Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool.",
      "",
      agentToolEntry.metadata.description ?? "",
    ].join("\n"),
  },
};

function createTaskToolEntryFromAgent(entry: ToolEntry): ToolEntry {
  return {
    ...entry,
    capability: "Claude Code-compatible alias for launching a ZCode subagent",
    metadata: {
      ...entry.metadata,
      name: TASK_TOOL_NAME,
      providerVisible: false,
      description: [
        "Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool.",
        "",
        entry.metadata.description ?? "",
      ].join("\n"),
    },
  };
}

export function createAgentToolEntry(
  _options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    /** 见 buildAgentProviderDescription：缺省 true，只有用户设置显式关闭时才去掉工作流那一行。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return {
    ...agentToolEntry,
    metadata: {
      ...agentToolEntry.metadata,
      description: buildAgentProviderDescription(_options),
    },
  };
}

export function createTaskToolEntry(
  options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    /** Task 是 Agent 的兼容别名，描述整段内嵌 Agent 的，因此同一道门一起传下去。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return createTaskToolEntryFromAgent(createAgentToolEntry(options));
}
