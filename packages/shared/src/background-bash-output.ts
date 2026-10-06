import { z } from "zod";

export const BACKGROUND_BASH_OUTPUT_MAX_BYTES = 8192;

/** 后台详情的单次文件快照；不进入 conversation snapshot 或持久化事件。 */
export const backgroundBashOutputSchema = z.strictObject({
  kind: z.literal("output"),
  workId: z.string().min(1),
  status: z.enum(["running", "completed", "failed", "timed_out", "cancelled", "spawn_error"]),
  output: z.string().max(BACKGROUND_BASH_OUTPUT_MAX_BYTES),
  truncated: z.boolean(),
  outputPath: z.string().min(1),
  /**
   * 进程元信息，全部可选：冷恢复或执行器已不在时查询直接 `unavailable`，
   * 但同一次查询里命令与 cwd 可能缺席（例如 argv 形态没有命令行），
   * UI 必须能在缺席时退回 tab 标题而不是空白。
   */
  startedAt: z.number().int().nonnegative().optional(),
  /** 结算时刻；缺席表示已终态但结算尚未完成（Stop 先标 cancelled 的窗口）。 */
  completedAt: z.number().int().nonnegative().optional(),
  /** 终态退出码；仅在执行器已结算时存在。 */
  exitCode: z.number().int().optional(),
  /** 启动命令原文；只有 shell 形态才有。 */
  command: z.string().optional(),
  /** 归一化后的绝对工作目录。 */
  cwd: z.string().optional(),
  /** 输出文件当前总大小（不是本次读到的字节数）：用于「已产出多少」。 */
  stdoutBytes: z.number().int().nonnegative().optional(),
});

export const backgroundBashOutputResultSchema = z.union([
  backgroundBashOutputSchema,
  z.strictObject({
    kind: z.enum(["unavailable", "unsupported", "read_failed"]),
    workId: z.string().min(1),
    code: z.string().optional(),
  }),
]);
export type BackgroundBashOutput = z.infer<typeof backgroundBashOutputSchema>;
export type BackgroundBashOutputResult = z.infer<typeof backgroundBashOutputResultSchema>;
