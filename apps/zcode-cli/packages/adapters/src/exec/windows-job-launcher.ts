/**
 * Windows 执行 Job 的启动闸门（docs/specs/windows-bash-process-tree-stop.md）。
 *
 * 问题：`spawn` 返回时子进程已经在跑，而 Job 只能在拿到 pid 之后异步 attach。
 * 用户可以在这段窗口里派生孙进程并立刻退出，attach 晚到便只能覆盖“还没退出的成员”，
 * 于是停止与结算都失去对象。
 *
 * 做法：先启动一个最小启动器（launcher），它只挂在 IPC 上等待放行；宿主**同时**等到
 * 启动器就绪与作业分配完成后才发出 `run`，启动器这时才 spawn 真实命令。于是真实命令从
 * 创建的第一刻就是作业成员，后代成员身份由内核继承，中间 shell 退出、后代 reparent 都不脱离。
 *
 * 语义保持：真实命令继承启动器的 stdio（0/1/2 直接复用宿主的句柄，不经过转发），
 * 目标 env / cwd / shell / windowsHide 经 IPC 原样交给启动器；启动器以真实命令的退出码退出。
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import type { PreparedChildSpawn } from "./execution-adapter-types.js";
import {
  JOB_LAUNCHER_COMMAND,
  LAUNCHER_EVAL_SOURCE,
  resolveJobLauncherSpawn,
  type JobLauncherTarget,
  type LauncherStartResult,
} from "./job-launcher-command.js";

export type { LauncherStartResult };

/**
 * 闸门建立期限：覆盖「spawn 启动器 + ready 握手 + 完成作业分配」。
 * 到期即中止本次执行，不再启动真实命令；这不是用来掩盖同步错误的超时兜底，而是
 * 作业工厂永不 settle（原生调用挂起）时保护执行与 close 有界结束的真实启动期限。
 */
const GATE_DEADLINE_MS = 10_000;
/**
 * 启动器退出后等待最后一条 IPC 消息的宽限。
 * 通道是异步读取的，'exit' 可能早于 'message' 送达；这段时间只用于让已写出的结局消息落位。
 */
const LAUNCHER_EXIT_GRACE_MS = 250;

export interface WindowsJobGate {
  /** 启动器进程；它是本次执行的树根与作业成员，兜底 taskkill 也从它开始。 */
  readonly child: ChildProcess;
  /** 启动器已就绪且可以接收放行消息；false 表示闸门没建立。 */
  readonly ready: Promise<boolean>;
  /** 真实命令的启动结局：成功时宿主照常读 stdio，失败时还原成 spawn_error。 */
  readonly commandStart: Promise<LauncherStartResult>;
  /** 放行真实命令；重复调用或已中止都无副作用。 */
  release(): void;
  /** 不放行（停止、结算、作业分配失败或期限到期时调用）。 */
  abort(message?: string): void;
}

type LauncherMessage =
  | { type: "ready" }
  | { type: "spawned" }
  | { type: "spawn-error"; message: string }
  | { type: "exiting" };

/**
 * 为一次 Windows 执行创建启动闸门。
 * 非 Windows 返回 undefined（调用方走直接 spawn）；Windows 上启动器本身起不来时抛错，
 * 由 `run()` 还原成明确的 `spawn_error`，绝不退回无所有权保证的直接 spawn。
 */
export function spawnWithWindowsJobGate(
  prepared: PreparedChildSpawn,
  options: { platform?: NodeJS.Platform } = {},
): WindowsJobGate | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;

  const target: JobLauncherTarget = {
    file: prepared.command.file,
    args: prepared.command.args,
    cwd: typeof prepared.spawnOptions.cwd === "string" ? prepared.spawnOptions.cwd : undefined,
    shell: prepared.command.shell,
    // 用户视角的环境：启动器为自身注入的 Node 选项不得在这里出现。
    env: buildTargetEnv(prepared.spawnOptions.env ?? {}),
    windowsHide: prepared.spawnOptions.windowsHide ?? true,
  };

  const spawnSpec = resolveJobLauncherSpawn();
  const launcherArgs =
    spawnSpec.args.length > 0 && spawnSpec.args[spawnSpec.args.length - 1] === JOB_LAUNCHER_COMMAND
      ? spawnSpec.args
      : // 没有可用的 CLI 入口：用 --eval 启动同一协议的自包含启动器。
        ["--eval", LAUNCHER_EVAL_SOURCE];

  const stdio: StdioOptions = [
    ...(prepared.spawnOptions.stdio as unknown[]),
    "ipc",
  ] as StdioOptions;
  let child: ChildProcess;
  try {
    child = spawn(spawnSpec.command, launcherArgs, {
      cwd: prepared.spawnOptions.cwd,
      // wrapper 自我净化：NODE_OPTIONS 等只影响启动器自己，真实命令的目标 env 由 IPC 传递。
      env: buildLauncherEnv(prepared.spawnOptions.env ?? {}),
      stdio,
      windowsHide: prepared.spawnOptions.windowsHide ?? true,
    });
  } catch (error) {
    // 连启动器都起不来时不能退回「直接 spawn + taskkill」：那条路径无法在 root 退出后
    // 找到已 reparent 的后代。抛出后由 run() 统一还原成 spawn_error。
    throw new Error("Windows process tree ownership is unavailable: launcher spawn failed", {
      cause: error,
    });
  }
  // 启动器入口只影响「谁来跑同一套 IPC 协议」，宿主侧处理完全相同。

  let released = false;
  let aborted = false;
  let commandStarted = false;
  let resolveCommandStart: (result: LauncherStartResult) => void = () => undefined;
  const commandStart = new Promise<LauncherStartResult>((resolve) => {
    resolveCommandStart = resolve;
  });
  const settleCommandStart = (result: LauncherStartResult) => {
    if (commandStarted) return;
    commandStarted = true;
    resolveCommandStart(result);
  };

  let gateReady = false;
  let resolveReady: (value: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const markReady = (value: boolean) => {
    if (gateReady) return;
    gateReady = true;
    resolveReady(value);
  };

  const onMessage = (message: unknown) => {
    const parsed = parseLauncherMessage(message);
    if (!parsed) return;
    if (parsed.type === "ready") return markReady(true);
    if (parsed.type === "spawned") return settleCommandStart({ ok: true });
    if (parsed.type === "spawn-error") {
      settleCommandStart({ ok: false, message: parsed.message });
      return;
    }
    // "exiting"：命令已退出，退出码由进程 exit 事件给出。
  };
  // 启动器在回报 ready 之前就消失：闸门不可用。
  const onLauncherError = () => {
    markReady(false);
    settleCommandStart({ ok: false, message: "Command failed to start" });
  };
  // 启动器退出而命令结局还没到：结局消息一定是在退出前写入通道的（flush 链），
  // 所以等通道关闭（已无待读数据）再把未到达的情况按「命令已启动」收口。
  // 被外部终止（停止/结算）或启动器自身崩溃时不会有任何结局消息，此时不能把这次执行
  // 误报成 spawn_error——退出码与停止结果才是真相。
  const onLauncherExit = () => {
    markReady(false);
    const settleWhenDrained = () => settleCommandStart({ ok: true });
    const graceTimer = setTimeout(settleWhenDrained, LAUNCHER_EXIT_GRACE_MS);
    graceTimer.unref?.();
    child.once("close", () => {
      clearTimeout(graceTimer);
      settleWhenDrained();
    });
    void commandStart.finally(() => clearTimeout(graceTimer));
  };
  child.on("message", onMessage);
  child.once("error", onLauncherError);
  child.once("exit", onLauncherExit);

  return {
    child,
    ready,
    commandStart,
    release() {
      if (released || aborted) return;
      released = true;
      try {
        child.send({ type: "run", payload: target });
      } catch {
        // IPC 已断开时启动器会自行退出；真实命令不会被启动，也不会留下孤儿。
        settleCommandStart({ ok: false, message: "Command failed to start" });
      }
    },
    abort(message?: string) {
      if (aborted) return;
      aborted = true;
      markReady(false);
      settleCommandStart({ ok: false, message: message ?? "Command failed to start" });
    },
  };
}

/** 闸门建立期限；调用方与闸门共同使用，保证停止与 close 有界。 */
export const WINDOWS_JOB_GATE_DEADLINE_MS = GATE_DEADLINE_MS;

/**
 * 目标命令的环境：原样保留用户值（含 `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`），
 * 只丢掉 undefined。启动器自己的 Node 选项走 `buildLauncherEnv`，不在这里改写。
 */
function buildTargetEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const target: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    target[key] = value;
  }
  return target;
}

/**
 * 启动器自身的环境：保留宿主的 Node 运行条件，但清空会重复执行预加载模块的选项
 * （`--import`/`--require` 之类写在 NODE_OPTIONS 里时，wrapper 会先跑一遍，用户命令再跑一遍）。
 */
function buildLauncherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const launcherEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  // wrapper 只需要能启动；预加载模块属于目标命令，不能在这里重复执行。
  delete launcherEnv.NODE_OPTIONS;
  return launcherEnv;
}

function parseLauncherMessage(message: unknown): LauncherMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { type?: unknown; message?: unknown };
  if (record.type === "ready") return { type: "ready" };
  if (record.type === "spawned") return { type: "spawned" };
  if (record.type === "exiting") return { type: "exiting" };
  if (record.type === "spawn-error") {
    return {
      type: "spawn-error",
      message: typeof record.message === "string" ? record.message : "Command failed to start",
    };
  }
  return undefined;
}
