/**
 * 子进程结局与关闭事件的接线（docs/specs/windows-bash-process-tree-stop.md）。
 *
 * 这里只做事件翻译，不持有执行状态：`finalize` 与 `finish` 仍由执行器提供（负责幂等、
 * 资源遥测与 Bash 生命周期回调），本模块按启动器形态裁决结局。
 *
 * 启动器形态下 exit 可能早于启动结局消息到达：必须等 `gateStartResult` 才能区分
 * 「命令正常退出」与「命令根本没起来」（后者必须还原成 spawn_error）。
 */
import type { ChildProcess } from "node:child_process";
import type { ExitState } from "./execution-adapter-types.js";
import type { LauncherStartResult } from "./windows-job-launcher.js";

export interface ChildExitTrackingOptions {
  /** 启动器形态的启动结局；直接 spawn 时为 undefined。 */
  gateStartResult?: Promise<LauncherStartResult>;
  /** 进程自身 error 事件；调用方在此撤销会话进程登记。 */
  onStartError: (error: Error) => void;
  /** 进程 exit 事件；调用方在此撤销会话进程登记。 */
  onExit: () => void;
  /** 通道关闭（stdio 全部 EOF）。 */
  onClosed: () => void;
  /** 执行器的结算入口：幂等落定、资源遥测与生命周期回调。 */
  finalize: (state: ExitState) => void;
}

export interface ChildExitTracking {
  exitPromise: Promise<ExitState>;
  closePromise: Promise<void>;
  /** 由执行器其它路径（停止、启动失败）主动落定结局；重复调用无副作用。 */
  finish(state: ExitState): void;
}

export function createChildExitTracking(
  child: ChildProcess,
  options: ChildExitTrackingOptions,
): ChildExitTracking {
  let settled = false;
  let resolveExit: (state: ExitState) => void = () => undefined;
  const exitPromise = new Promise<ExitState>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (state: ExitState) => {
    if (settled) return;
    settled = true;
    options.finalize(state);
    resolveExit(state);
  };

  child.once("error", (error) => {
    options.onStartError(error);
    finish({ error });
  });
  child.once("exit", (code, signal) => {
    options.onExit();
    const state: ExitState = { code: code ?? undefined, signal: signal ?? undefined };
    if (!options.gateStartResult) {
      finish(state);
      return;
    }
    void options.gateStartResult.then((start) => {
      finish(start.ok ? state : { error: new Error(start.message) });
    });
  });
  const closePromise = new Promise<void>((resolve) => {
    child.once("close", () => {
      options.onClosed();
      resolve();
    });
  });

  return { exitPromise, closePromise, finish };
}
