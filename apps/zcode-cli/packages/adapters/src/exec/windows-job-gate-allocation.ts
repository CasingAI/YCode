/**
 * 等待「启动器就绪 + 作业分配完成」后才放行真实命令
 * （docs/specs/windows-bash-process-tree-stop.md）。
 *
 * 顺序必须两件都到位：只看启动器 ready 时，延迟返回的 assign 会让命令先跑起来，
 * 快速退出的 root 仍能派生逃出作业的后代。期限到期、停止抢先或作业不可用时，
 * 一律不放行命令，由调用方回收启动器与晚到的作业句柄。
 */
import type { WindowsJobObjectController } from "../mcp/windows-job-object.js";
import { WINDOWS_JOB_GATE_DEADLINE_MS, type WindowsJobGate } from "./windows-job-launcher.js";

export interface WindowsJobGateAllocationOptions<T> {
  gate: WindowsJobGate;
  /** 把启动器自身绑定进本次执行的作业；失败返回 undefined 视为作业不可用。 */
  attachJob: (pid: number | undefined) => Promise<WindowsJobObjectController | undefined>;
  isStopRequested: () => boolean;
  /** 停止抢先时的结算结果。 */
  stoppedResult: () => T;
  /** 作业/启动器不可用时的结算结果；message 必须说明所有权不可用。 */
  unavailable: (message: string) => T;
}

export type WindowsJobGateAllocation<T> =
  | { kind: "ready"; job: Promise<WindowsJobObjectController | undefined> }
  | { kind: "result"; result: T };

export async function awaitWindowsJobGateAllocation<T>(
  options: WindowsJobGateAllocationOptions<T>,
): Promise<WindowsJobGateAllocation<T>> {
  const { gate } = options;
  const jobPromise = options.attachJob(gate.child.pid);
  // 只有闸门判定「不放行命令」时才回收作业；正常放行时作业必须继续持有，
  // 否则刚分配的作业会在启动器 ready 前被 terminate，命令永远起不来。
  const discardGateJob = () => {
    void jobPromise.then((job) => {
      if (!job) return;
      try {
        job.terminate();
      } catch {
        // 作业里最多只有启动器自己。
      }
      try {
        job.close();
      } catch {
        // 关闭失败不影响已返回的停止/失败结果。
      }
    });
  };

  const deadline = new Promise<"deadline">((resolve) => {
    const timer = setTimeout(() => resolve("deadline"), WINDOWS_JOB_GATE_DEADLINE_MS);
    timer.unref?.();
  });
  const allocation = await Promise.race([
    Promise.all([gate.ready, jobPromise]).then(([ready, job]) => ({ ready, job })),
    deadline,
  ]);

  if (allocation === "deadline") {
    const message = "Windows process tree ownership was not available before the startup deadline";
    gate.abort(message);
    gate.child.kill("SIGKILL");
    discardGateJob();
    return { kind: "result", result: options.unavailable(message) };
  }
  if (options.isStopRequested()) {
    gate.abort();
    gate.child.kill("SIGKILL");
    discardGateJob();
    return { kind: "result", result: options.stoppedResult() };
  }
  // 没有作业就不能放行命令：root 退出后 taskkill /T 找不到已 reparent 的后代，
  // 静默运行等于放弃“每次执行拥有整棵派生树”的保证。
  if (!allocation.job) {
    const message = "Windows process tree ownership is unavailable";
    gate.abort(message);
    gate.child.kill("SIGKILL");
    return { kind: "result", result: options.unavailable(message) };
  }
  if (!allocation.ready) {
    // 启动器没起来（宿主无法拉 Node）：同样不能放行，回收后按启动失败返回。
    gate.abort("Command failed to start");
    gate.child.kill("SIGKILL");
    discardGateJob();
    return { kind: "result", result: options.unavailable("Command failed to start") };
  }
  return { kind: "ready", job: jobPromise };
}
