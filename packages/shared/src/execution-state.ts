import { z } from "zod";

/**
 * 权限轴四档：计划模式 / 只读模式 / 完全访问 / Team 团队档。
 * 旧值 build（变更前确认）、edit（自动编辑）、auto（保留未实现）已从权限轴移除；
 * 旧值 bare（秘书白名单档）已改名 team，行为差异全在提示词层（docs/specs/team-mode.md）。
 * 升级前落盘的数据先经 normalizeLegacyExecutionMode 归一，再进入这里。
 */
export const executionPermissionModeSchema = z.enum(["plan", "readonly", "yolo", "team"]);
export type ExecutionPermissionMode = z.infer<typeof executionPermissionModeSchema>;

export const DEFAULT_EXECUTION_MODE: ExecutionPermissionMode = "yolo";

/** Goal 拒绝白名单：plan / readonly。yolo 与 team 放行。 */
export function isGoalRestrictedMode(mode: string | undefined): boolean {
  return mode === "plan" || mode === "readonly";
}

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

/** 模式种子必须区分「明确档位」与「没有数据」，不能把缺值伪造成完全访问。 */
export function resolvePersistedExecutionMode(raw: unknown): ExecutionPermissionMode | undefined {
  if (typeof raw === "string") {
    if (raw === "plan") return "plan";
    if (raw === "readonly") return "readonly";
    // 旧秘书档 bare 整体迁移为 team（docs/specs/team-mode.md「迁移」）。
    if (raw === "team" || raw === "bare") return "team";
    if (raw === "yolo") return "yolo";
    // build / edit / auto / 未知值无法判定档位。
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as { mode?: unknown; planEnabled?: unknown; readOnlyEnabled?: unknown };
  if (record.planEnabled === true || record.mode === "plan") return "plan";
  if (record.readOnlyEnabled === true || record.mode === "readonly") return "readonly";
  if (record.mode === "team" || record.mode === "bare") return "team";
  if (record.mode === "yolo") return "yolo";
  return undefined;
}

/**
 * 升级前落盘数据的迁移入口。旧格式有两处：状态快照是「四档 mode + planEnabled /
 * readOnlyEnabled 两个叠加位」的对象，配置项是裸的四档 mode 字符串。全仓只在读取边界调用。
 *
 * 旧计划会话必须还原成 plan —— 落到完全访问等于提权。旧 readonly 位同理。
 */
export function normalizeLegacyExecutionMode(raw: unknown): ExecutionPermissionMode {
  return resolvePersistedExecutionMode(raw) ?? DEFAULT_EXECUTION_MODE;
}
