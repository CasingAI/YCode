// ============================================================
// Bash 后台停止分支（runtime.stopBackgroundTask 的 local_bash 分派）
// ============================================================
// 与 background-stop-sandbox.ts / background-stop-dynamic-workflow.ts 同形：
// background.ts 侧只保留一个 import 与一行分派，避免超限大文件继续膨胀。
// 行为零改动：原样搬运 stopLocalBashBackgroundTask（含 lost 结算与事件）。

import { SessionEventType } from "../deps.js";
import type {
  BackgroundTaskInfoStatus,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isTerminalRuntimeTask } from "../../runtime-task/registry.js";
import type {
  RuntimeBackgroundStopResult,
  TypedRuntimeBackgroundStopTarget,
} from "./background-stop-types.js";
import {
  commandFromRuntimeTask,
  descriptionFromRuntimeTask,
} from "./background-task-mapping.js";

export async function stopLocalBashBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  traceContext: TraceContext,
): Promise<RuntimeBackgroundStopResult> {
  if (!this.executionPort?.cancelBackgroundTask) {
    return {
      ok: false,
      reason: "background_task_cancel_not_supported",
      status: target.currentStatus,
      taskId: target.taskId,
      ...(target.taskType ? { type: target.taskType } : {}),
    };
  }

  const cancelRequestedAt = new Date();
  if (target.existing?.status === "running") {
    await this.appendEvent(
      this.createEvent(
        SessionEventType.BackgroundTaskUpdated,
        this.buildBackgroundTaskPayload(target.taskId, target.existing, undefined, {
          cancelRequestedAt,
          cancellable: false,
          status: "running",
        }),
        traceContext,
      ),
      traceContext,
    );
  }

  const snapshot = await this.executionPort.cancelBackgroundTask(target.taskId);
  if (!snapshot) {
    const completedAt = new Date();
    if (target.registryTask) {
      this.runtimeTaskRegistry.update(target.taskId, (current) =>
        isTerminalRuntimeTask(current)
          ? current
          : {
              ...current,
              completedAt,
              isBackgrounded: true,
              status: "lost",
            },
      );
    }
    await this.appendEvent(
      this.createEvent(
        SessionEventType.BackgroundTaskCompleted,
        this.buildBackgroundTaskPayload(target.taskId, target.existing, undefined, {
          cancelRequestedAt,
          cancellable: false,
          completedAt,
          status: "lost",
        }),
        traceContext,
      ),
      traceContext,
    );
    return {
      ok: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: target.taskId,
      type: "local_bash",
    };
  }

  const status: BackgroundTaskInfoStatus =
    snapshot.status === "running" ? "cancelled" : snapshot.status;
  if (!target.registryTask) {
    await this.appendEvent(
      this.createEvent(
        SessionEventType.BackgroundTaskCompleted,
        this.buildBackgroundTaskPayload(target.taskId, target.existing, snapshot, {
          cancelRequestedAt,
          cancellable: false,
          completedAt: snapshot.completedAt ?? new Date(),
          status,
        }),
        traceContext,
      ),
      traceContext,
    );
  }
  return {
    command: commandFromRuntimeTask(target.registryTask, target.existing),
    description: descriptionFromRuntimeTask(target.registryTask, target.existing),
    ok: true,
    status,
    taskId: target.taskId,
    type: "local_bash",
  };
}
