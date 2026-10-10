import { z } from "zod";

export const SANDBOX_CONSOLE_SNAPSHOT_MAX_LINES = 500;
export const SANDBOX_CONSOLE_LINE_MAX_CHARS = 2048;
export const SANDBOX_EXECUTION_ROWS_MAX = 100;
export const SANDBOX_EXECUTION_PREVIEW_MAX_CHARS = 120;
/** 执行行源码全文上限（字符；与 sandboxEval 输入 64KiB 对齐，超限截断并标记）。 */
export const SANDBOX_EXECUTION_CODE_MAX_CHARS = 65536;

/** 沙盒控制台的单次只读快照；不进入 conversation snapshot 或持久化事件。 */
export const sandboxConsoleSnapshotSchema = z.strictObject({
  kind: z.literal("output"),
  sessionId: z.string().min(1),
  /** 活实例是否在内存（false = 已死亡，tab 显示死亡覆盖）。 */
  alive: z.boolean(),
  executions: z
    .array(
      z.strictObject({
        seq: z.number().int().nonnegative(),
        source: z.enum(["model", "user"]),
        preview: z.string().max(SANDBOX_EXECUTION_PREVIEW_MAX_CHARS + 8),
        truncated: z.boolean(),
        /** 源码有界全文（只读专用视图的展示源；超限截断时 codeTruncated 为 true）。 */
        code: z.string().max(SANDBOX_EXECUTION_CODE_MAX_CHARS + 16),
        codeTruncated: z.boolean(),
        at: z.number().int().nonnegative(),
      }),
    )
    .max(SANDBOX_EXECUTION_ROWS_MAX),
  lines: z
    .array(
      z.strictObject({
        seq: z.number().int().nonnegative(),
        at: z.number().int().nonnegative(),
        method: z.string().min(1).max(16),
        text: z.string().max(SANDBOX_CONSOLE_LINE_MAX_CHARS),
      }),
    )
    .max(SANDBOX_CONSOLE_SNAPSHOT_MAX_LINES),
  truncated: z.boolean(),
});

export const sandboxConsoleResultSchema = z.union([
  sandboxConsoleSnapshotSchema,
  z.strictObject({
    kind: z.enum(["unavailable", "unsupported", "read_failed"]),
    sessionId: z.string().min(1),
    code: z.string().optional(),
  }),
]);
export type SandboxConsoleSnapshot = z.infer<typeof sandboxConsoleSnapshotSchema>;
export type SandboxConsoleResult = z.infer<typeof sandboxConsoleResultSchema>;

export const sandboxConsoleParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
});
export type SandboxConsoleParams = z.infer<typeof sandboxConsoleParamsSchema>;

/**
 * 沙盒活实例存在性投影（状态面板「沙盒」分区、分区的点开入口、已开 tab 的死亡覆盖，
 * 三者都读这一个查询，不各猜）。轻量：只有 alive 布尔，不带执行行与 console。
 */
export const sandboxStatusResultSchema = z.union([
  z.strictObject({
    kind: z.literal("alive"),
    sessionId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.enum(["unavailable", "unsupported", "read_failed"]),
    sessionId: z.string().min(1),
    code: z.string().optional(),
  }),
]);
export type SandboxStatusResult = z.infer<typeof sandboxStatusResultSchema>;

export const sandboxStatusParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
});
export type SandboxStatusParams = z.infer<typeof sandboxStatusParamsSchema>;
