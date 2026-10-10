/**
 * Sandbox 工具的结果卡 display 构造。
 *
 * 与 history-display.ts 同一骨架：safeParse 输出 schema → 极简载荷。
 * 载荷只带状态与后台 ID：折叠行的说明文本渲染器从 toolCall.input.description
 * 读（Bash 卡同款 getExecuteDescription 惯例），不经载荷转手——模型通道零改动。
 * 字段表与降级语义见 docs/specs/sandbox-system-tool.md「聊天工具卡」。
 */

import {
  SANDBOX_TOOL_NAME,
  SandboxOutputSchema,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

export function createSandboxDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== SANDBOX_TOOL_NAME) return undefined;
  const parsed = SandboxOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  return {
    kind: "sandbox",
    status: data.status,
    ...(data.backgroundTaskId ? { backgroundTaskId: data.backgroundTaskId } : {}),
  };
}
