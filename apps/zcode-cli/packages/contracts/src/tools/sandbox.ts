// ============================================================
// Sandbox 工具：会话级 QuickJS 隔离计算面（History 同级 always-on 系统工具）
// ============================================================
// 阶段2只放说明/源码/路径/超时四字段：后台/重置参数等阶段3/4再加，避免模型
// 提前传空能力。源码与路径互斥（XOR 由 schema  superRefine 保证，不执行即失败）。
// 超时对齐 Bash（默认 120s、最大 600s）。规则见 docs/specs/sandbox-system-tool.md。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SANDBOX_TOOL_NAME = "Sandbox";

export const SANDBOX_DEFAULT_TIMEOUT_MS = 120_000;
export const SANDBOX_MAX_TIMEOUT_MS = 600_000;

const SandboxDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Required. Clear, concise description of what this computation does in active voice, written in the user's language. The chat card shows only this sentence when folded; source and output appear when expanded.",
  );

const SandboxSourceSchema = z
  .string()
  .describe("Inline JavaScript source to evaluate. Mutually exclusive with filePath.");

const SandboxFilePathSchema = z
  .string()
  .min(1)
  .describe(
    "Path to a single file to read and evaluate (relative paths resolve against the session working directory, like Bash cwd). Only this one file is read; other files it references are not loaded. Mutually exclusive with code.",
  );

const SandboxTimeoutSchema = z
  .number()
  .int()
  .positive()
  .max(SANDBOX_MAX_TIMEOUT_MS)
  .optional()
  .describe(`Optional timeout in milliseconds (max ${SANDBOX_MAX_TIMEOUT_MS}). Defaults to ${SANDBOX_DEFAULT_TIMEOUT_MS}.`);

export const SandboxInputSchema = z
  .object({
    description: SandboxDescriptionSchema,
    code: SandboxSourceSchema.optional(),
    filePath: SandboxFilePathSchema.optional(),
    timeout: SandboxTimeoutSchema,
    reset: z
      .boolean()
      .optional()
      .describe(
        "Set to true to destroy the current instance first, then run this call in a fresh instance. LocalStorage is preserved.",
      ),
    runInBackground: z
      .boolean()
      .optional()
      .describe(
        "Set to true to run this evaluation in the background. Returns a background task ID; read windowed console output plus return value with TaskOutput.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    // 原因与修复依据：这条 message 经输入校验投影原样回给模型，是模型可见契约，
    // 必须点名冲突字段并给出处理动作（spec「代码从哪来」），不得含糊。
    const hasCode = value.code !== undefined;
    const hasPath = value.filePath !== undefined;
    if (hasCode && hasPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one of `code` and `filePath`: both were provided, remove one of them.",
      });
    } else if (!hasCode && !hasPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one of `code` and `filePath`: neither was provided, add one of them.",
      });
    }
  });

export type SandboxInput = z.infer<typeof SandboxInputSchema>;

export const SandboxOutputSchema = z
  .object({
    status: z.enum(["success", "failed", "backgrounded"]),
    /** `return` 交回值的文本投影（转不了标类型，仍算成功；无 return 时缺席）。 */
    returnText: z.string().optional(),
    /** 该次调用开始 → 交回时刻之间新产生的 console 文本（多行按换行拼接）。 */
    console: z.string(),
    /** console 是否因环上限被截断。 */
    consoleTruncated: z.boolean().optional(),
    /** 失败时的错误信息（含读文件失败、语法错、未接住抛错）。 */
    error: z.string().optional(),
    /** 后台任务 ID（阶段4前不出现；预留字段）。 */
    backgroundTaskId: z.string().optional(),
    /** 新实例提示（新建实例后的第一次调用为 true，工具返回里包一段提示，只写一次）。 */
    isNewInstance: z.boolean().optional(),
  })
  .strict();

export type SandboxOutput = z.infer<typeof SandboxOutputSchema>;

export const SandboxInputJsonSchema = toToolJsonSchema(SandboxInputSchema);
export const SandboxOutputJsonSchema = toToolJsonSchema(SandboxOutputSchema);

// 聊天工具卡 display 载荷（阶段5）：只带状态与后台 ID。折叠行的说明文本渲染器
// 从 toolCall.input.description 读（Bash 卡同款惯例），不进载荷——模型通道零改动。
// 规则见 docs/specs/sandbox-system-tool.md「聊天工具卡」；与 shared/sandbox-display.ts
// 严格同步（zod v3 / v4 两侧各一份，逐字段对齐）。
export const sandboxToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("sandbox"),
    status: z.enum(["success", "failed", "backgrounded"]),
    backgroundTaskId: z.string().min(1).optional(),
  })
  .strict();

export type SandboxToolResultDisplayPayload = z.infer<
  typeof sandboxToolResultDisplayPayloadSchema
>;
