// ============================================================
// Sandbox 工具（会话级 QuickJS 隔离计算面）的工具卡 display 载荷
// ============================================================
// 照 history-display.ts 的先例单独成模块（特性级 schema 不堆进 toolDisplay.ts）。
//
// ⚠ 与 apps/zcode-cli/packages/contracts/src/tools/sandbox.ts 的
// sandboxToolResultDisplayPayloadSchema 必须同步——两侧都是 strict，缺一侧整条
// row/display 校验失败、工具卡退化成 kindLabel 一行（fail-closed，不报错）。
// 规则与字段表见 docs/specs/sandbox-system-tool.md「聊天工具卡」。

import { z } from "zod";

export const toolCallSandboxDisplaySchema = z
  .object({
    kind: z.literal("sandbox"),
    status: z.enum(["success", "failed", "backgrounded"]),
    backgroundTaskId: z.string().min(1).optional(),
  })
  .strict();
export type ToolCallSandboxDisplay = z.infer<typeof toolCallSandboxDisplaySchema>;
