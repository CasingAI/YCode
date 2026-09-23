// ============================================================
// ListPlans tool - list a session's plan files and return the latest
// ============================================================
// 计划文件的唯一所有者是运行时（见 docs/specs/session-plan-files.md）：
// ExitPlanMode 的 beforePermission 钩子在审批门之前落盘到
// `.zcode/plans/<sessionId>/<planId>.md`。上下文压缩或换回合后，模型靠本工具
// 找回计划：一次调用返回全部计划的清单 + 最新一份的全文，更早的计划只给路径。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_PLANS_TOOL_NAME = "ListPlans";

export const ListPlansInputSchema = z.object({}).strict();
export type ListPlansInput = z.infer<typeof ListPlansInputSchema>;
export const ListPlansInputJsonSchema = toToolJsonSchema(ListPlansInputSchema);

export const SessionPlanSummarySchema = z
  .object({
    planId: z.string().describe("Plan file id: <UTC timestamp>-<toolCallId>, sortable by name."),
    path: z.string().describe("Absolute path of the plan file; read it with the Read tool."),
    title: z
      .string()
      .nullable()
      .describe("Title from the file frontmatter, falling back to the plan's first heading."),
    overview: z
      .string()
      .nullable()
      .describe("Short summary from the file frontmatter, null when the plan has none."),
    createdAt: z
      .string()
      .nullable()
      .describe("ISO timestamp parsed from the planId prefix, null for unparsable ids."),
    isLatest: z.boolean().describe("Whether this is the most recent plan of the session."),
  })
  .strict();
export type SessionPlanSummary = z.infer<typeof SessionPlanSummarySchema>;

export const ListPlansOutputSchema = z
  .object({
    plans: z
      .array(SessionPlanSummarySchema)
      .describe("All plans of the current session in chronological order (oldest first)."),
    latest: z
      .object({
        planId: z.string(),
        path: z.string(),
        title: z.string().nullable(),
        overview: z.string().nullable(),
        content: z
          .string()
          .describe("Full markdown body of the latest plan, without the frontmatter block."),
      })
      .nullable()
      .describe("The most recent plan with its full content, null when the session has none."),
  })
  .strict();
export type ListPlansOutput = z.infer<typeof ListPlansOutputSchema>;
export const ListPlansOutputJsonSchema = toToolJsonSchema(ListPlansOutputSchema);
