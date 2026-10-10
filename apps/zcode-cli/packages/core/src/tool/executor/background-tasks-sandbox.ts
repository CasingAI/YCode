// ============================================================
// Sandbox 后台任务的追踪适配：快照源 + 终态等待者
// ============================================================
// 从 background-tasks.ts 拆出：该文件顶到 oxlint max-lines 上限（400 行）。
// 实例表是唯一事实源（TaskOutput 投影读同一份快照）；形状用
// BackgroundExecutionSnapshot 的可选字段承载：console 窗口进 stdoutTail，
// 失败信息进 error；status 对齐 running/completed/failed。tracker 的轮询、
// 终态结算、通知都经这一个形状，不再为沙盒另开快照类型。

import type { BackgroundExecutionSnapshot } from "@zcode/contracts";

/**
 * 沙盒后台任务的快照源（tracker 1s 轮询用）。
 */
export async function getSandboxBackgroundSnapshot(
  taskId: string,
): Promise<BackgroundExecutionSnapshot | undefined> {
  const { getSandboxInstanceTable } = await import("../../sandbox/session.js");
  const table = getSandboxInstanceTable();
  const snapshot = table.getBackgroundEval(taskId);
  if (!snapshot) return undefined;
  const { consoleLines } = table.readConsoleWindowForBackground(taskId, {});
  const consoleText = consoleLines.map((line) => line.text).join("\n");
  const text =
    snapshot.returnText !== undefined && snapshot.returnText.length > 0
      ? (consoleText.length > 0 ? `${consoleText}\n${snapshot.returnText}` : snapshot.returnText)
      : consoleText;
  return {
    taskId: snapshot.taskId,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
    stdoutTail: text,
    ...(snapshot.error
      ? { error: { type: "unknown" as const, message: snapshot.error.message } }
      : {}),
  };
}

/**
 * 沙盒后台任务的终态直接等待者（比 1s 轮询更及时）。实例销毁后旧 ID 读失败：
 * 这里回 undefined，tracker 按 snapshot_missing 收口为 lost（与其它工具同轨道）。
 */
export async function waitForSandboxBackgroundTerminal(
  taskId: string,
): Promise<BackgroundExecutionSnapshot | undefined> {
  const { getSandboxInstanceTable } = await import("../../sandbox/session.js");
  const table = getSandboxInstanceTable();
  const settled = await table.waitForBackgroundEval(taskId);
  if (!settled || settled.status === "running") return getSandboxBackgroundSnapshot(taskId);
  return getSandboxBackgroundSnapshot(taskId);
}
