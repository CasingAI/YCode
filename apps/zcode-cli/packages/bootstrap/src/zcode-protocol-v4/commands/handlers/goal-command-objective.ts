import { sliceGoalCommandArgs } from "@zcode/shared";

/**
 * 从用户输入取出 goal 目标正文。句中 `/goal` 只取 token 之后，避免把前情写进 target。
 */
export function parseGoalObjectiveFromCommandText(text: string): string {
  const args = sliceGoalCommandArgs(text);
  return args.replace(/^replace\s+/i, "").trim();
}
