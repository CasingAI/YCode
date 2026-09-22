// ============================================================
// ListPlans Tool Handler
// ============================================================
// 计划文件的唯一所有者是运行时（docs/specs/session-plan-files.md）：ExitPlanMode 的
// beforePermission 钩子在审批门之前落盘到 `.zcode/plans/<sessionId>/<planId>.md`。
// 压缩或换回合后模型靠本工具找回计划：一次调用返回全部计划清单 + 最新一份全文，
// 更早的计划只给路径，由模型用 Read 自取。

import {
  CoreErrorType,
  LIST_PLANS_TOOL_NAME,
  ListPlansInputJsonSchema,
  ListPlansInputSchema,
  ListPlansOutputJsonSchema,
  ListPlansOutputSchema,
  createCoreError,
  type FileSystemPort,
  type ListPlansOutput,
  type SessionPlanSummary,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import {
  listSessionPlanFiles,
  parseSessionPlanId,
  readSessionPlanFile,
} from "../../runtime/helpers/plan-file-continuity.js";

const MAX_LIST_PLANS_MODEL_BYTES = 200_000;
// 标题只需要开头；探测预算避免为「列清单」读全部计划的全文（全文只读最新一份）。
const PLAN_TITLE_PROBE_BYTES = 2_048;
// 与 UI 的 getPlanDirectoryTitle 同一条规则：首个 H1 优先，否则首个非空文本行。
const PLAN_TITLE_H1_PATTERN = /^\s{0,3}#(?!#)\s+(.+?)\s*#*\s*$/m;
const PLAN_TITLE_LEADING_DECORATION = /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/;
const PLAN_TITLE_MAX_CHARS = 120;

const listPlansHandler: ToolHandler = async (input, context) => {
  ListPlansInputSchema.parse(input);

  if (!context.fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for ListPlans",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: LIST_PLANS_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const files = await listSessionPlanFiles({
    abortSignal: context.abortSignal,
    fileSystemPort: context.fileSystemPort,
    sessionId: context.sessionId,
    workspaceRoot: context.workspaceRoot,
  });

  const latestIndex = files.length - 1;
  const plans: SessionPlanSummary[] = [];
  for (const [index, file] of files.entries()) {
    plans.push({
      planId: file.planId,
      path: file.path,
      title: await readSessionPlanTitle(context.fileSystemPort, context, file.path),
      createdAt: parseSessionPlanId(file.planId).createdAt ?? null,
      isLatest: index === latestIndex,
    });
  }

  const latestFile = files.at(-1);
  let latest: ListPlansOutput["latest"] = null;
  if (latestFile) {
    const file = await readSessionPlanFile({
      abortSignal: context.abortSignal,
      fileSystemPort: context.fileSystemPort,
      path: latestFile.path,
    });
    if (file) {
      latest = {
        planId: latestFile.planId,
        path: latestFile.path,
        title: plans.at(-1)?.title ?? null,
        content: file.content,
      };
    }
  }

  return { plans, latest } satisfies ListPlansOutput;
};

export const listPlansToolEntry: ToolEntry = {
  capability: "List this session's plan files and return the latest plan content",
  metadata: {
    name: LIST_PLANS_TOOL_NAME,
    description:
      "List all plan files of the current session (created when a plan was submitted via ExitPlanMode) and return the full content of the latest one. Use this after context compaction or when the plan text is no longer in context; older plans are returned as file paths you can read yourself.",
    modelInstructions: [
      "Use when the current task references a plan whose text is no longer in context, e.g. after context compaction.",
      "The latest plan's full content is included in the result; older plans must be read with the Read tool using the returned paths.",
      "Read-only: safe to call in any mode, including plan mode.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_LIST_PLANS_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listPlansHandler,
  formatModelContent: formatListPlansModelContent,
  inputSchema: ListPlansInputJsonSchema,
  outputSchema: ListPlansOutputJsonSchema,
  runtimeInputSchema: ListPlansInputSchema,
  runtimeOutputSchema: ListPlansOutputSchema,
  permission: listPlansPermission(),
  resultBudget: {
    maxInlineBytes: MAX_LIST_PLANS_MODEL_BYTES,
    maxModelBytes: MAX_LIST_PLANS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_LIST_PLANS_MODEL_BYTES,
      direction: "head" as const,
    },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 30_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ListPlans was cancelled before the plan list was returned",
  },
  trace: {
    required: true as const,
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  },
};

function listPlansPermission(): ToolPermissionSpec {
  return {
    permission: "session.plans.read",
    reason: "ListPlans only reads this session's plan files",
    riskLevel: "low" as const,
    sideEffectScope: "session" as const,
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk" as const,
  };
}

async function readSessionPlanTitle(
  fileSystemPort: FileSystemPort,
  context: ToolExecutionContext,
  path: string,
): Promise<string | null> {
  const probe = await readSessionPlanFile({
    abortSignal: context.abortSignal,
    fileSystemPort,
    maxBytes: PLAN_TITLE_PROBE_BYTES,
    path,
  });
  if (!probe) return null;
  return extractPlanTitle(probe.content);
}

function extractPlanTitle(content: string): string | null {
  const h1 = PLAN_TITLE_H1_PATTERN.exec(content)?.[1]?.trim();
  if (h1) return truncateTitle(h1);
  for (const line of content.split(/\r?\n/u)) {
    const title = line.replace(PLAN_TITLE_LEADING_DECORATION, "").trim();
    if (title) return truncateTitle(title);
  }
  return null;
}

function truncateTitle(title: string): string | null {
  const truncated = title.length > PLAN_TITLE_MAX_CHARS ? title.slice(0, PLAN_TITLE_MAX_CHARS) : title;
  return truncated || null;
}

function formatListPlansModelContent(output: unknown): string {
  const result = output as ListPlansOutput;
  if (result.plans.length === 0) {
    return "No plan files exist for this session. Plans are created when ExitPlanMode submits a plan in plan mode.";
  }

  const lines = result.plans.map((plan) => {
    const marker = plan.isLatest ? " [latest]" : "";
    const title = plan.title ? ` — ${plan.title}` : "";
    return `- ${plan.path}${marker}${title}`;
  });
  const latestBlock = result.latest
    ? ["", "## Latest plan", "", result.latest.content].join("\n")
    : "";
  return [`Found ${result.plans.length} plan(s) in this session:`, ...lines].join("\n") + latestBlock;
}
