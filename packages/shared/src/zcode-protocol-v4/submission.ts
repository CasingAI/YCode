import { z } from "zod";

/** Composer 可以显式提交的 Agent mode；与权限轴同值域，只有三档。 */
export const submissionModeSchema = z.enum(["plan", "readonly", "yolo"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;

/**
 * 提交类命令的 mode 出现在三个位置之一：sendText / sendGoalCommand / switchCollaborationMode
 * 是顶层，createSession 在 config 与 firstInput 里。旧执行端的权限轴没有 plan 档，
 * 收到 plan 会当未知值回落到原档；发送前用它做能力门禁，避免「以为进了计划模式」。
 */
export function commandPayloadRequestsPlanMode(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as { mode?: unknown; config?: unknown; firstInput?: unknown };
  if (record.mode === "plan") return true;
  return [record.config, record.firstInput].some(
    (nested) =>
      typeof nested === "object" &&
      nested !== null &&
      (nested as { mode?: unknown }).mode === "plan",
  );
}
