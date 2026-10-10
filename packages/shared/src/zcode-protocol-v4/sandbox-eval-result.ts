import { z } from "zod";

// sandboxEval / sandboxReset 的命令结果（阶段8可交互面）。
// 失败态用协议 kind，不靠抛错：网关对领域错误原样上行 ACK result，UI 按 kind 分流。

/** 用户 eval 的单次结果：return 文本 + 本次窗口 console；失败带结构化错误。 */
export const sandboxEvalResultSchema = z.union([
  z.strictObject({
    kind: z.literal("completed"),
    sessionId: z.string().min(1),
    /** `return` 交回值的文本投影（无 return 时缺席）。 */
    returnText: z.string().optional(),
    /** 该次 eval 开始 → 交回时刻之间新产生的 console 文本（多行按换行拼接）。 */
    console: z.string(),
    consoleTruncated: z.boolean(),
    /** 新建实例后的第一次用户 eval 为 true（控制台内提示，不进模型通道）。 */
    isNewInstance: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.enum(["failed", "unavailable", "unsupported"]),
    sessionId: z.string().min(1),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
]);
export type SandboxEvalResult = z.infer<typeof sandboxEvalResultSchema>;

/** 重置结果：销毁实例、LocalStorage 留下；在途与后台 ID 全失效。 */
export const sandboxResetResultSchema = z.union([
  z.strictObject({
    kind: z.literal("reset"),
    sessionId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.enum(["unavailable", "unsupported"]),
    sessionId: z.string().min(1),
    code: z.string().optional(),
  }),
]);
export type SandboxResetResult = z.infer<typeof sandboxResetResultSchema>;
