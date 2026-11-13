/**
 * 执行 Job 的启动器入口（docs/specs/windows-bash-process-tree-stop.md）。
 *
 * 启动器只做「等放行 → spawn 真实命令 → 传退出码」，不解析、不缓冲、不改写任何输出。
 * 它必须能被两种方式启动：
 * - 非 SEA：`node --eval <LAUNCHER_EVAL_SOURCE>`（开发态与测试都没有 CLI 入口可自 re-exec）；
 * - SEA 单文件：`process.execPath __zcode-job-launcher`，走 CLI 内部命令分派
 *   （与 `__zcode-browser-host` 同机制）。
 *
 * 两条路径都靠父进程的 IPC 通道完成闸门握手，因此语义完全一致；SEA 不再是残缺形态。
 */

import { spawn, type ChildProcess } from "node:child_process";

/** CLI 内部命令名。与 `ZCODE_BROWSER_HOST_COMMAND` 同族，必须与入口分派字面量一致。 */
export const JOB_LAUNCHER_COMMAND = "__zcode-job-launcher";

/** 真实命令的启动结局：失败必须还原成 spawn_error，不能表现为启动器退出 127。 */
export type LauncherStartResult = { ok: true } | { ok: false; message: string };

export interface JobLauncherRuntime {
  execPath: string;
  isSea: boolean;
}

export interface JobLauncherSpawn {
  command: string;
  args: string[];
}

export interface ResolveJobLauncherSpawnOptions {
  runtime?: JobLauncherRuntime;
}

/**
 * 解析启动器的自 re-exec 命令。
 *
 * 只有 SEA 单文件需要且能够走 `process.execPath __zcode-job-launcher`：那里没有脚本入口，
 * `--eval` 也不被单文件运行时解释。非 SEA（开发态、测试、普通 Node 宿主）返回空 args，
 * 由调用方用 `--eval` 起同一协议的启动器。`--eval` 源码是自包含的内置模块调用，不需要
 * 继承宿主的 loader 参数；更不能用 `process.argv[1]` 冒充 CLI 入口，那会把宿主入口再跑一遍。
 */
export function resolveJobLauncherSpawn(
  options: ResolveJobLauncherSpawnOptions = {},
): JobLauncherSpawn {
  const runtime = options.runtime ?? defaultRuntime();
  if (!runtime.isSea) return { command: runtime.execPath, args: [] };
  return { command: runtime.execPath, args: [JOB_LAUNCHER_COMMAND] };
}

export interface JobLauncherTarget {
  file: string;
  args: string[];
  cwd?: string;
  shell?: boolean | string;
  env: Record<string, string>;
  windowsHide?: boolean;
}

/**
 * 在启动器进程内运行闸门协议，返回进程退出码。
 *
 * 父进程（执行器）先收到 `ready`，在完成作业分配后才发出 `run`；本函数这时才 spawn
 * 真实命令，让命令从创建的第一刻就是作业成员。真实命令继承启动器的 stdio。
 */
export function runJobLauncherCommand(): Promise<number> {
  return new Promise<number>((resolve) => {
    let released = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      try {
        process.disconnect();
      } catch {
        // 通道已关闭或本来就不是 IPC 子进程。
      }
      resolve(code);
    };
    // 结局消息必须先于退出送达：process.exit / disconnect 会丢弃未 flush 的 IPC 帧。
    const send = (message: unknown, done: () => void) => {
      try {
        if (typeof process.send !== "function") return done();
        process.send(message, () => done());
      } catch {
        done();
      }
    };
    const fail = (message: string) => {
      send({ type: "spawn-error", message }, () => finish(127));
    };

    if (typeof process.send !== "function" || typeof process.on !== "function") {
      // 不是闸门子进程：没有任何可做的事，直接退出，绝不执行未知命令。
      finish(0);
      return;
    }

    process.on("message", (message: unknown) => {
      if (released) return;
      if (typeof message !== "object" || message === null) return;
      const record = message as { type?: unknown; payload?: unknown };
      if (record.type !== "run") return;
      const payload = record.payload as JobLauncherTarget | undefined;
      if (!payload || typeof payload !== "object") return;
      released = true;
      let child: ChildProcess;
      try {
        child = spawn(payload.file, payload.args, {
          cwd: payload.cwd,
          // 目标环境由父进程经 IPC 传入：启动器自己继承的是净化过的 wrapper 环境，
          // 不能再拿 process.env 覆盖用户真正想要的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE。
          env: payload.env,
          shell: payload.shell,
          stdio: "inherit",
          windowsHide: payload.windowsHide ?? true,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
      }
      if (child.pid !== undefined) send({ type: "spawned" }, () => undefined);
      child.on("error", (error: Error) => fail(error.message));
      child.on("exit", (code) => send({ type: "exiting" }, () => finish(code ?? 1)));
    });
    // 父进程放弃放行（停止/结算抢先或作业分配失败）时，不得自行启动命令。
    process.on("disconnect", () => {
      if (!released) finish(0);
    });
    process.send({ type: "ready" });
  });
}

/**
 * 非 SEA 的 `--eval` 启动器源码。
 * 与 {@link runJobLauncherCommand} 保持同一协议；这里保持自包含（只 require 内置模块），
 * 因为 `--eval` 无法经模块解析加载 TypeScript 源码。
 */
export const LAUNCHER_EVAL_SOURCE = String.raw`
const { spawn } = require("node:child_process");
let released = false;
let settled = false;
const finish = (code) => {
  if (settled) return;
  settled = true;
  try { process.disconnect(); } catch {}
  process.exit(code);
};
const send = (message, done) => {
  try {
    if (typeof process.send !== "function") return done();
    process.send(message, () => done());
  } catch {
    done();
  }
};
const fail = (message) => {
  send({ type: "spawn-error", message: message }, () => finish(127));
};
process.on("message", (message) => {
  if (released) return;
  if (!message || message.type !== "run") return;
  const payload = message.payload;
  if (!payload) return;
  released = true;
  let child;
  try {
    child = spawn(payload.file, payload.args, {
      cwd: payload.cwd,
      env: payload.env,
      shell: payload.shell,
      stdio: "inherit",
      windowsHide: payload.windowsHide !== false,
    });
  } catch (error) {
    fail(String((error && error.message) || error));
    return;
  }
  if (child.pid !== undefined) send({ type: "spawned" }, () => {});
  child.on("error", (error) => fail(String((error && error.message) || error)));
  child.on("exit", (code) => send({ type: "exiting" }, () => finish(code === null ? 1 : code)));
});
process.on("disconnect", () => {
  if (!released) finish(0);
});
if (typeof process.send === "function") process.send({ type: "ready" });
`;

function defaultRuntime(): JobLauncherRuntime {
  return {
    execPath: process.execPath,
    isSea: isSeaRuntime(),
  };
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea(): boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}
