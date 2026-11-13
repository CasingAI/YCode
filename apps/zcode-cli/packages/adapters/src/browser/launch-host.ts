import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { ZCODE_BROWSER_HOST_COMMAND } from "@zcode/contracts/plugins";

/**
 * Linux CLI 受管浏览器的 idle 启动宿主解析与协议（docs/specs/process-priority.md）。
 *
 * 这里复用与 `officialPluginHostPrefixArgs` 相同的自 re-exec 方式：SEA 下直接执行本二进制，
 * 非 SEA 下带上过滤后的 `process.execArgv` 和当前 CLI 入口。不能 fork bundler 不会产出的
 * 临时 `.ts`/`.js` 文件，也不访问 Playwright 私有字段。
 *
 * 宿主在加载 Playwright 前自降为 idle；父 CLI 保持 below-normal，只 connect 和清理。
 * 关闭顺序固定为“close 行/EOF → 有界等待退出 → 仅对本宿主 SIGKILL”；宿主自己的 watchdog
 * 会先强制结束它创建的 BrowserServer，避免父进程强杀后留下 detached 浏览器。
 */

export const MANAGED_BROWSER_LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
] as const;

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const CLOSE_MESSAGE = '{"type":"close"}\n';

export interface BrowserLaunchHost {
  wsEndpoint: string;
  close(): Promise<void>;
}

export interface BrowserLaunchHostContext {
  executablePath?: string;
  args: readonly string[];
}

export type BrowserLaunchHostFactory = (
  context: BrowserLaunchHostContext,
) => Promise<BrowserLaunchHost>;

export interface BrowserLaunchHostRuntime {
  execPath: string;
  execArgv: readonly string[];
  argv1: string | undefined;
  isSea: boolean;
}

export interface ResolveBrowserLaunchHostCommandOptions {
  closeTimeoutMs: number;
  runtime?: BrowserLaunchHostRuntime;
}

export interface BrowserLaunchHostCommand {
  command: string;
  args: string[];
}

export type BrowserLaunchHostSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface SpawnBrowserLaunchHostOptions {
  closeTimeoutMs: number;
  readyTimeoutMs?: number;
  /** 测试接缝；缺省使用 node:child_process.spawn。 */
  spawn?: BrowserLaunchHostSpawn;
  /** 测试接缝；缺省读取当前进程的 execPath/execArgv/argv[1] 与 SEA 状态。 */
  runtime?: BrowserLaunchHostRuntime;
}

export async function spawnBrowserLaunchHost(
  context: BrowserLaunchHostContext,
  options: SpawnBrowserLaunchHostOptions,
): Promise<BrowserLaunchHost> {
  const command = resolveBrowserLaunchHostCommand(context, {
    closeTimeoutMs: options.closeTimeoutMs,
    runtime: options.runtime,
  });
  const spawnChild: BrowserLaunchHostSpawn = options.spawn ?? (spawn as BrowserLaunchHostSpawn);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnChild(command.command, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
    });
  } catch (error) {
    throw new Error("Failed to start the browser launch host.", { cause: error });
  }
  // 尽早注册所有管道错误，避免握手前或父进程退出时出现 unhandled error。
  guardChildStreams(child);
  return await waitForHostReady(child, options);
}

/** 解析自 re-exec 命令；SEA 只执行二进制，开发态保留入口但过滤 inspector 旗标。 */
export function resolveBrowserLaunchHostCommand(
  context: BrowserLaunchHostContext,
  options: ResolveBrowserLaunchHostCommandOptions,
): BrowserLaunchHostCommand {
  const payload = JSON.stringify({
    ...(context.executablePath === undefined ? {} : { executablePath: context.executablePath }),
    args: [...context.args],
    closeTimeoutMs: options.closeTimeoutMs,
  });
  const runtime = options.runtime ?? defaultRuntime();
  if (runtime.isSea) {
    return { command: runtime.execPath, args: [ZCODE_BROWSER_HOST_COMMAND, payload] };
  }
  if (!runtime.argv1) {
    throw new Error("Cannot resolve the CLI entrypoint for the browser launch host.");
  }
  return {
    command: runtime.execPath,
    args: [
      ...filterBrowserHostExecArgv(runtime.execArgv),
      resolve(runtime.argv1),
      ZCODE_BROWSER_HOST_COMMAND,
      payload,
    ],
  };
}

/** 工作进程不应继承调试端口或断点等待；普通 V8/资源旗标保留。 */
export function filterBrowserHostExecArgv(execArgv: readonly string[]): string[] {
  return execArgv.filter((arg) => !/^--inspect(?:-brk|-wait)?(?:=|$)/u.test(arg));
}

function defaultRuntime(): BrowserLaunchHostRuntime {
  return {
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv1: process.argv[1],
    isSea: isSeaRuntime(),
  };
}

function guardChildStreams(child: ChildProcessWithoutNullStreams): void {
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  child.stderr.on("error", () => undefined);
}

function waitForHostReady(
  child: ChildProcessWithoutNullStreams,
  options: SpawnBrowserLaunchHostOptions,
): Promise<BrowserLaunchHost> {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  return new Promise<BrowserLaunchHost>((resolveHost, rejectHost) => {
    let settled = false;
    let buffer = "";
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.off("error", onStdoutError);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 先请求优雅关闭并结束 stdin，再有界等待；超时只强制结束本次 spawn 的宿主。
      void terminateHost(child, options.closeTimeoutMs).then(
        () => rejectHost(toError(cause)),
        () => rejectHost(toError(cause)),
      );
    };
    const succeed = (wsEndpoint: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveHost(createHostHandle(child, wsEndpoint, options.closeTimeoutMs));
    };
    const onData = (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = parseHostMessage(line);
        if (message?.type === "ready") succeed(message.wsEndpoint);
        else if (message?.type === "error") fail(new Error(message.message));
        if (settled) return;
      }
    };
    const onError = (error: Error) => {
      fail(new Error("Failed to start the browser launch host.", { cause: error }));
    };
    const onStdoutError = (error: Error) => {
      fail(new Error("Failed to start the browser launch host.", { cause: error }));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `The browser launch host exited before it was ready (${code ?? signal ?? "unknown"}).`,
        ),
      );
    };

    timer = setTimeout(() => {
      fail(new Error("The browser launch host did not become ready in time."));
    }, readyTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stdout.on("error", onStdoutError);
    // 宿主的 stderr 可能包含 profile/CDP 细节，只 drain 不转发给调用方。
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => undefined);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function parseHostMessage(
  line: string,
): { type: "ready"; wsEndpoint: string } | { type: "error"; message: string } | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.type === "ready" && typeof record.wsEndpoint === "string") {
      return { type: "ready", wsEndpoint: record.wsEndpoint };
    }
    if (record.type === "error") {
      return {
        type: "error",
        message:
          typeof record.message === "string" ? record.message : "Browser launch host failed.",
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function createHostHandle(
  child: ChildProcessWithoutNullStreams,
  wsEndpoint: string,
  closeTimeoutMs: number,
): BrowserLaunchHost {
  let closing: Promise<void> | undefined;
  return {
    wsEndpoint,
    close: () => {
      closing ??= terminateHost(child, closeTimeoutMs);
      return closing;
    },
  };
}

/**
 * 有界关闭本次 spawn 的宿主：写 close 行并结束 stdin（EOF），等待宿主自行清理并退出；
 * 超时后才 SIGKILL。宿主的 watchdog 会在该等待窗口内先结束它自己的 BrowserServer。
 */
async function terminateHost(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (hasExited(child)) return;
  requestGracefulClose(child);
  const exited = await waitForChildExit(child, timeoutMs);
  if (!exited) forceKillHost(child);
}

function requestGracefulClose(child: ChildProcessWithoutNullStreams): void {
  try {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end(CLOSE_MESSAGE);
    }
  } catch {
    // stdin 已关闭时宿主仍会收到 EOF 并自行清理。
  }
}

function forceKillHost(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // 终止失败只影响清理尽力程度。
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolveExit) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea?: () => boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea?.() === true;
  } catch {
    return false;
  }
}
