import { z } from "zod";

/**
 * 权限轴只有三档：计划模式 / 只读模式 / 完全访问。
 * 旧值 build（变更前确认）、edit（自动编辑）、auto（保留未实现）已从权限轴移除；
 * 升级前落盘的数据先经 normalizeLegacyExecutionMode 归一，再进入这里。
 */
export const executionPermissionModeSchema = z.enum(["plan", "readonly", "yolo"]);
export type ExecutionPermissionMode = z.infer<typeof executionPermissionModeSchema>;

export const DEFAULT_EXECUTION_MODE: ExecutionPermissionMode = "yolo";

export const executionStateSchema = z.object({ mode: executionPermissionModeSchema });
export type ExecutionState = z.infer<typeof executionStateSchema>;

const DEFAULT_EXECUTION_STATE: ExecutionState = { mode: DEFAULT_EXECUTION_MODE };

/** 在接纳边界固定本次提交的模式，不能在队列消费时按当前配置重新解释。 */
export function resolveExecutionState(
  input: { mode?: string },
  current: ExecutionState = DEFAULT_EXECUTION_STATE,
): ExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  return { mode: mode.success ? mode.data : current.mode };
}

/**
 * 升级前落盘数据的迁移入口。旧格式有两处：状态快照是「四档 mode + planEnabled /
 * readOnlyEnabled 两个叠加位」的对象，配置项是裸的四档 mode 字符串。全仓只在读取边界调用。
 *
 * 旧计划会话必须还原成 plan —— 落到完全访问等于提权。旧 readonly 位同理。
 */
export function normalizeLegacyExecutionMode(raw: unknown): ExecutionPermissionMode {
  if (typeof raw === "string") {
    if (raw === "plan") return "plan";
    if (raw === "readonly") return "readonly";
    // build / edit / auto / yolo / 未知值都收敛到默认档。
    return DEFAULT_EXECUTION_MODE;
  }
  if (!raw || typeof raw !== "object") return DEFAULT_EXECUTION_MODE;
  const record = raw as { mode?: unknown; planEnabled?: unknown; readOnlyEnabled?: unknown };
  if (record.planEnabled === true || record.mode === "plan") return "plan";
  if (record.readOnlyEnabled === true || record.mode === "readonly") return "readonly";
  return DEFAULT_EXECUTION_MODE;
}
