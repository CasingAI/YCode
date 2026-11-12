// 计划卡「执行计划」的目标档解析（docs/specs/plan-card-execute.md 规则 21-22）。
//
// 目标只由 runtime 在进入 Plan 时派生（Team 来源 → team，其余 → yolo），随快照
// config.planExecuteMode 下发；UI 不推断来源，也不读 previousMode / 历史消息。
// 这里只裁决「点击旧计划时本次提交用哪一档」，并保证任何分支都不会恢复 readonly。
//
// 把「解析」与「同步先切档再发送」抽成 UI 内唯一实现，SessionPane 与隔离浏览器
// 回归共用同一路径，避免测试另写一份平行 handler。

export type PlanExecuteTarget = "team" | "yolo";

/** 只依赖快照与草稿里与档位有关的两个字段，不绑定完整 SessionConfigState。 */
export interface PlanExecutionConfigSource {
  mode?: unknown;
  /** runtime 在 Plan 内派生；shared schema 尚未落地时按未知值防守读取。 */
  planExecuteMode?: unknown;
}

function isPlanExecuteTarget(value: unknown): value is PlanExecuteTarget {
  return value === "team" || value === "yolo";
}

/**
 * 点击旧计划时的执行目标读取优先级（plan-card-execute.md 规则 22）：
 * 1. 快照仍在 Plan：取快照权威 planExecuteMode ?? yolo，忽略草稿；
 * 2. 非 Plan 且草稿为 team / yolo：保留草稿（Team 执行后再点旧计划不降 Agent）；
 * 3. 非 Plan 且草稿为 plan / readonly / 缺失：回退当前会话档的 team / yolo；
 * 4. 仍无法得到 team / yolo：yolo。
 */
export function resolvePlanExecuteTarget(input: {
  snapshotConfig?: PlanExecutionConfigSource | null;
  draftMode?: unknown;
}): PlanExecuteTarget {
  const snapshotConfig = input.snapshotConfig;
  if (snapshotConfig?.mode === "plan") {
    return isPlanExecuteTarget(snapshotConfig.planExecuteMode)
      ? snapshotConfig.planExecuteMode
      : "yolo";
  }
  if (isPlanExecuteTarget(input.draftMode)) return input.draftMode;
  if (isPlanExecuteTarget(snapshotConfig?.mode)) return snapshotConfig.mode;
  return "yolo";
}

/**
 * 执行计划：解析目标后必须在同一同步栈内先切档、再发送。
 *
 * `switchMode` 走既有草稿写入路径（useDraftConfigControl 会同步更新 draftConfigRef），
 * `sendText` 紧随其后冻结本次 submission；分两帧会让提交带上旧的 Plan 档。
 */
export function executePlanSubmission(input: {
  snapshotConfig?: PlanExecutionConfigSource | null;
  draftMode?: unknown;
  switchMode: (mode: PlanExecuteTarget) => void;
  sendText: () => void;
}): PlanExecuteTarget {
  const target = resolvePlanExecuteTarget(input);
  input.switchMode(target);
  input.sendText();
  return target;
}
