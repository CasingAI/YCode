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
  isFileSystemPortError,
  type FileSystemPort,
  type ListPlansOutput,
  type SessionPlanSummary,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import {
  extractPlanTitleFromBody,
  listSessionPlanFiles,
  parseSessionPlanFile,
  readSessionPlanFile,
} from "../../runtime/helpers/plan-file-continuity.js";

const MAX_LIST_PLANS_MODEL_BYTES = 200_000;

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
    // 单份计划读不出来时只降级这一条，不失败整个工具：清单里其余计划和最新一份全文
    // 仍然拿得到，模型也能从 overview 里直接看到这份为什么读不了。
    const summary = await readSessionPlanSummary(context.fileSystemPort, context, file.path).catch(
      (error: unknown) => {
        if (isFileSystemPortError(error) && error.code === "cancelled") throw error;
        return {
          overview: `无法读取该计划文件：${error instanceof Error ? error.message : String(error)}`,
          title: null,
        };
      },
    );
    plans.push({
      planId: file.planId,
      path: file.path,
      title: summary.title,
      overview: summary.overview,
      createdAt: file.createdAt ?? null,
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
      // latest.content 只含剥掉 frontmatter 的正文；元数据已在结构化字段里，不给模型重复噪音。
      const { body, overview } = parseSessionPlanFile(file.content);
      latest = {
        planId: latestFile.planId,
        path: latestFile.path,
        title: plans.at(-1)?.title ?? null,
        overview: overview ?? null,
        content: body,
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

async function readSessionPlanSummary(
  fileSystemPort: FileSystemPort,
  context: ToolExecutionContext,
  path: string,
): Promise<{ overview: string | null; title: string | null }> {
  // 整份读，不设字节预算：计划正文在 ExitPlanMode 的 schema 里已被
  // PLAN_MODE_MAX_PLAN_CHARS 封顶，文件天然有界。曾经这里按 8192 字节切前缀，
  // 而中文三字节一字，截断点只有三分之一落在字符边界上，切中的那些会被读成乱码。
  const file = await readSessionPlanFile({
    abortSignal: context.abortSignal,
    fileSystemPort,
    path,
  });
  if (!file) return { overview: null, title: null };
  const parsed = parseSessionPlanFile(file.content);
  return {
    overview: parsed.overview ?? null,
    // frontmatter 有 title 用之；否则回退正文提取（历史无 frontmatter 文件走同一回退）。
    title: parsed.title ?? extractPlanTitleFromBody(parsed.body) ?? null,
  };
}

function formatListPlansModelContent(output: unknown): string {
  const result = output as ListPlansOutput;
  if (result.plans.length === 0) {
    return "No plan files exist for this session. Plans are created when ExitPlanMode submits a plan in plan mode.";
  }

  const lines = result.plans.map((plan) => {
    const marker = plan.isLatest ? " [latest]" : "";
    const title = plan.title ? ` — ${plan.title}` : "";
    const overview = plan.overview ? ` — ${plan.overview}` : "";
    return `- ${plan.path}${marker}${title}${overview}`;
  });
  const latestBlock = result.latest
    ? ["", "## Latest plan", "", result.latest.content].join("\n")
    : "";
  return [`Found ${result.plans.length} plan(s) in this session:`, ...lines].join("\n") + latestBlock;
}
