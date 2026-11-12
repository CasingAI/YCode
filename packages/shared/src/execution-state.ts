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

/**
 * 计划卡「执行计划」的目标档位。它不是权限轴第五档：仅 mode === "plan" 时存在，
 * 进入 Plan 时由来源档派生（Team → team，其余 → yolo），离开 Plan 即清除。
 */
export const planExecuteModeSchema = z.enum(["team", "yolo"]);
export type PlanExecuteMode = z.infer<typeof planExecuteModeSchema>;

export const executionStateSchema = z.object({
  mode: executionPermissionModeSchema,
  planExecuteMode: planExecuteModeSchema.optional(),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

const DEFAULT_EXECUTION_STATE: ExecutionState = { mode: DEFAULT_EXECUTION_MODE };

/**
 * 在接纳边界固定本次提交的模式，不能在队列消费时按当前配置重新解释。
 * 命令输入只接受 mode：planExecuteMode 一律由当前权威状态派生，不信任载荷传入值。
 */
export function resolveExecutionState(
  input: { mode?: string },
  current: ExecutionState = DEFAULT_EXECUTION_STATE,
): ExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  const nextMode = mode.success ? mode.data : current.mode;
  if (nextMode !== "plan") return { mode: nextMode };
  // 已在 Plan 内重复进入不改写既有目标；从 Team 进入保留 team，其余来源一律 yolo。
  // 新建 / 无来源 / 旧数据缺目标同样落到 yolo，不能把缺值伪造成 Team。
  if (current.mode === "plan") {
    return { mode: "plan", planExecuteMode: current.planExecuteMode ?? "yolo" };
  }
  return { mode: "plan", planExecuteMode: current.mode === "team" ? "team" : "yolo" };
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

/**
 * 读取会话落盘 entry / 历史事件的执行状态。旧数据没有 planExecuteMode：
 * mode 为 plan 时按 yolo 兜底，非 Plan 一律丢弃该字段（additive 兼容，不做迁移）。
 */
export function normalizeLegacyExecutionState(raw: unknown): ExecutionState {
  const mode = normalizeLegacyExecutionMode(raw);
  if (mode !== "plan") return { mode };
  const planExecuteMode =
    raw && typeof raw === "object"
      ? planExecuteModeSchema.safeParse((raw as { planExecuteMode?: unknown }).planExecuteMode)
      : undefined;
  return { mode, planExecuteMode: planExecuteMode?.success ? planExecuteMode.data : "yolo" };
}
