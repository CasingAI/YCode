// ============================================================
// 后台任务类型映射（background.ts 的纯函数下沉）
// ============================================================
// 原因：background.ts 基线已超行（HEAD 即 484 行），继续堆映射函数只会
// 加重超限。映射函数全是纯函数（不碰 runtime），抽到独立模块后
// background.ts 只保留分派与有副作用的停止分支。行为零改动。

import type {
  BackgroundTaskInfo,
  BackgroundTaskInfoStatus,
} from "../deps.js";
import type {
  RuntimeTaskSnapshot,
  RuntimeTaskType,
} from "../../runtime-task/registry.js";
import type { RuntimeBackgroundStopStatus } from "./background-stop-types.js";

export function backgroundInfoFromRuntimeTask(task: RuntimeTaskSnapshot): BackgroundTaskInfo {
  return {
    taskId: task.taskId,
    toolCallId:
      typeof task.parentToolCallId === "string" ? task.parentToolCallId : undefined,
    toolName: toolNameFromRuntimeTaskType(task.type),
    cancellable: task.status === "running",
    command: commandFromRuntimeTask(task, undefined),
    description: task.description,
    status: toBackgroundTaskInfoStatus(task.status) ?? "lost",
    pid: task.pid,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    outputPath: task.outputFile,
    terminalId: task.taskId,
  };
}

export function commandFromRuntimeTask(
  task: RuntimeTaskSnapshot | undefined,
  existing: BackgroundTaskInfo | undefined,
): string | undefined {
  // TaskStop 对 local_agent 返回短 description；旧 projection 的 command
  // 可能已保存为完整 prompt，因此运行时任务必须先于 existing.command 取值。
  if (task?.type === "local_agent") return task.description;
  if (!task && existing?.toolName === "Agent") return existing.description;
  if (existing?.command) return existing.command;
  if (task?.type === "local_bash") return task.description || task.prompt;
  return task?.prompt;
}

/**
 * 被停止任务的人类可读描述。它与 command 是两件事：command 是命令原文，
 * description 是模型当初写的那句话。TaskStop 卡片折叠行显示 description，
 * 命令原文留在展开区。
 *
 * 取值顺序与会话投影一致：投影条目里的 description 来自后台任务事件 payload
 * （即模型写的 input.description），是权威来源；runtime 任务快照的 description 兜底。
 * 两者都取不到就是没有描述，不回落成命令。
 */
export function descriptionFromRuntimeTask(
  task: RuntimeTaskSnapshot | undefined,
  existing: BackgroundTaskInfo | undefined,
): string | undefined {
  const description = existing?.description ?? task?.description;
  if (typeof description !== "string") return undefined;
  const trimmed = description.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function runtimeTaskTypeFromBackgroundInfo(
  task: BackgroundTaskInfo | undefined,
): RuntimeTaskType | undefined {
  switch (task?.toolName) {
    case "Bash":
      return "local_bash";
    case "JSVM":
      return "local_sandbox";
    case "Agent":
      return "local_agent";
    case "Workflow":
      return "local_workflow";
    case "CreateWorkflow":
    case "AmendWorkflow":
      return "local_dynamic_workflow";
    default:
      return undefined;
  }
}

export function toolNameFromRuntimeTaskType(type: RuntimeTaskType): string {
  switch (type) {
    case "local_agent":
      return "Agent";
    case "local_bash":
      return "Bash";
    case "local_sandbox":
      return "JSVM";
    case "local_workflow":
      return "Workflow";
    case "local_dynamic_workflow":
      return "CreateWorkflow";
    case "monitor_mcp":
      return "Monitor";
  }
}

export function isTerminalBackgroundTaskInfoStatus(
  status: BackgroundTaskInfoStatus | undefined,
): boolean {
  return Boolean(status && status !== "running");
}

export function toBackgroundTaskInfoStatus(
  status: RuntimeBackgroundStopStatus | undefined,
): BackgroundTaskInfoStatus | undefined {
  switch (status) {
    case "cancelled":
    case "killed":
    case "stopped":
      return "cancelled";
    case "completed":
    case "failed":
    case "lost":
    case "running":
    case "spawn_error":
    case "timed_out":
      return status;
    default:
      return undefined;
  }
}
