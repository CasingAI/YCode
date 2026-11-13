import { createInterface } from "node:readline";
import {
  MANAGED_BROWSER_LAUNCH_ARGS,
  resolveInstalledBrowserExecutable,
  type PlaywrightChromiumModule,
} from "@zcode/adapters/browser";
import {
  lowerProcessPriority,
  type ProcessPriority,
  type ProcessPriorityResult,
} from "@zcode/shared/process-priority";
import type { RunContext } from "@zcode/shared-types";
import type { BrowserServer } from "playwright-core";
import { loadCliPlaywrightChromium } from "./sea-playwright-runtime.js";

/**
 * Linux CLI 受管 headless Chromium 的 idle 启动宿主。
 *
 * 存在理由：Linux 的 nice 是线程级属性。Chromium 在 launch 就绪前已经创建
 * zygote/launcher 线程；launch 返回后按根 PID 设置只覆盖主线程，renderer 仍从既有
 * 线程 fork 并保持父 CLI 的 nice 10。宿主在加载 Playwright / 创建 Chromium 之前先让
 * 自己的主线程变成 idle，Chromium 根进程、zygote/launcher 和 renderer 才能继承 nice 19。
 *
 * 协议：stdout 单行 JSON 报告 ready/error；stdin 收到 `{"type":"close"}` 或 EOF（父进程
 * 退出）后关闭 BrowserServer 并退出。宿主独占 BrowserServer；父 CLI 只 connect。
 * 关闭请求有界：正常关闭挂起时先强制结束自己启动的浏览器，再由 watchdog 退出宿主。
 */

const BROWSER_HOST_FAILURE_MESSAGE =
  "Managed headless Chromium is unavailable: browser launch host failed.";
const DEFAULT_CLOSE_TIMEOUT_MS = 1_500;

export interface BrowserHostDependencies {
  loadPlaywright?: () => Promise<PlaywrightChromiumModule>;
  lower?: (pid: number, priority: ProcessPriority) => ProcessPriorityResult;
  /** 测试接缝；缺省调用 process.exit。 */
  exit?: (code: number) => void;
}

interface BrowserHostPayload {
  executablePath?: string;
  args?: string[];
  closeTimeoutMs?: number;
}

interface CloseRequest {
  closed: Promise<void>;
  isRequested(): boolean;
  dispose(): void;
}

type HostMessage = { type: "ready"; wsEndpoint: string } | { type: "error"; message: string };

export async function runBrowserHostCommand(
  ctx: RunContext,
  argv: string[],
  deps: BrowserHostDependencies = {},
): Promise<number> {
  // 解析失败等早退路径也必须吸收异步 EPIPE，避免 stdout 错误变成 unhandled。
  const guardOutputError = () => undefined;
  ctx.stdout.on("error", guardOutputError);
  try {
    return await runBrowserHost(ctx, argv, deps);
  } catch {
    // 不把原始异常（可能含 profile/CDP endpoint）写回父进程；父进程只按 launch 失败处理。
    writeHostMessage(ctx, { type: "error", message: BROWSER_HOST_FAILURE_MESSAGE });
    return 1;
  } finally {
    ctx.stdout.off("error", guardOutputError);
  }
}

async function runBrowserHost(
  ctx: RunContext,
  argv: string[],
  deps: BrowserHostDependencies,
): Promise<number> {
  // 必须先于 Playwright 加载和 Chromium 线程创建。main.ts 已按 idle 角色调用一次；
  // 这里幂等重试，保证模块被直接调用或入口顺序调整时仍然成立。
  try {
    (deps.lower ?? lowerProcessPriority)(process.pid, "idle");
  } catch {
    // 优先级只是资源策略；失败不阻断浏览器启动。
  }

  const payload = parsePayload(argv);
  const closeTimeoutMs = payload.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const closeRequest = createCloseRequest(ctx);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let server: BrowserServer | undefined;
  let serverClosing: Promise<void> | undefined;
  let watchdog: NodeJS.Timeout | undefined;

  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  };
  const finish = (code: number): number => {
    clearWatchdog();
    closeRequest.dispose();
    return code;
  };
  const closeServer = () => {
    serverClosing ??= (async () => {
      try {
        await server?.close();
      } catch {
        // 清理尽力而为；不改变父进程的取消/退出结果。
      }
    })();
    return serverClosing;
  };
  // 只强制结束自己 launchServer 启动的浏览器：公开的 BrowserServer.kill() 会同步向该
  // 浏览器的进程组发送 SIGKILL（含 zygote/launcher 和 renderer）；未持有 server 时由宿主退出关闭 pipe。
  const forceOwnBrowser = () => {
    try {
      // watchdog 不等待清理完成：组信号在 kill() 返回 Promise 前已同步发出。
      void server?.kill().catch(() => undefined);
    } catch {
      // 浏览器已退出或无法终止时不再重试。
    }
  };
  // 关闭请求后留出优雅关闭窗口；超时先杀自己的浏览器，再退出宿主。
  const startWatchdog = () => {
    if (watchdog) return;
    watchdog = setTimeout(
      () => {
        forceOwnBrowser();
        exit(0);
      },
      Math.max(1, Math.floor(closeTimeoutMs / 2)),
    );
    watchdog.unref?.();
  };
  void closeRequest.closed.then(startWatchdog);

  let playwright: PlaywrightChromiumModule;
  try {
    playwright = await (deps.loadPlaywright ?? loadCliPlaywrightChromium)();
  } catch {
    writeHostMessage(ctx, { type: "error", message: BROWSER_HOST_FAILURE_MESSAGE });
    return finish(1);
  }
  // load 期间父进程可能已退出或发出 close；此时不得再创建浏览器。
  if (closeRequest.isRequested()) return finish(0);

  try {
    const executablePath = resolveInstalledBrowserExecutable(playwright, {
      executablePath: payload.executablePath,
    });
    server = await playwright.chromium.launchServer({
      executablePath,
      headless: true,
      // 与进程内路径一致：只监听回环，避免 Playwright 缺省绑定 ::/0.0.0.0。
      host: "127.0.0.1",
      args: payload.args ?? [...MANAGED_BROWSER_LAUNCH_ARGS],
    });
  } catch {
    writeHostMessage(ctx, { type: "error", message: BROWSER_HOST_FAILURE_MESSAGE });
    return finish(1);
  }

  // launch 期间收到 close 或父进程退出：不写 ready，只关闭已创建的 server。
  if (closeRequest.isRequested()) {
    await closeServer();
    return finish(0);
  }

  let wsEndpoint: string;
  try {
    wsEndpoint = server.wsEndpoint();
  } catch {
    writeHostMessage(ctx, { type: "error", message: BROWSER_HOST_FAILURE_MESSAGE });
    await closeServer();
    return finish(1);
  }

  if (!writeHostMessage(ctx, { type: "ready", wsEndpoint })) {
    // stdout 同步写失败意味着父进程已无法接收 ready；关闭 server 并返回非零。
    await closeServer();
    return finish(1);
  }

  // 父进程可能在 ready 后立即关闭 stdin；close 行与 EOF 都走同一条关闭路径。
  await closeRequest.closed;
  await closeServer();
  return finish(0);
}

function parsePayload(argv: string[]): BrowserHostPayload {
  const raw = argv[0];
  if (raw === undefined || raw.trim() === "") return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid browser host payload.");
  }
  const record = parsed as Record<string, unknown>;
  const executablePath = record.executablePath;
  if (executablePath !== undefined && typeof executablePath !== "string") {
    throw new Error("Invalid browser host executablePath.");
  }
  const args = record.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
    throw new Error("Invalid browser host args.");
  }
  const closeTimeoutMs = record.closeTimeoutMs;
  if (
    closeTimeoutMs !== undefined &&
    (typeof closeTimeoutMs !== "number" || !Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0)
  ) {
    throw new Error("Invalid browser host closeTimeoutMs.");
  }
  return {
    ...(executablePath === undefined ? {} : { executablePath }),
    ...(args === undefined ? {} : { args: args as string[] }),
    ...(closeTimeoutMs === undefined
      ? {}
      : { closeTimeoutMs: Math.max(1, Math.trunc(closeTimeoutMs)) }),
  };
}

function createCloseRequest(ctx: RunContext): CloseRequest {
  const reader = createInterface({ input: ctx.stdin, crlfDelay: Infinity });
  let requested = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const requestClose = () => {
    if (requested) return;
    requested = true;
    resolveClosed();
  };
  const onLine = (line: string) => {
    try {
      const message = JSON.parse(line) as { type?: unknown };
      if (message.type === "close") requestClose();
    } catch {
      // stdin 只接受明确的 close 行；其它内容忽略。
    }
  };
  const onOutputError = () => requestClose();
  reader.on("line", onLine);
  reader.on("close", requestClose);
  ctx.stdout.on("error", onOutputError);
  const onSignal = () => requestClose();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  return {
    closed,
    isRequested: () => requested,
    dispose: () => {
      reader.off("line", onLine);
      reader.off("close", requestClose);
      ctx.stdout.off("error", onOutputError);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      reader.close();
    },
  };
}

function writeHostMessage(ctx: RunContext, message: HostMessage): boolean {
  try {
    ctx.stdout.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch {
    // 同步写失败由调用方进入关闭路径；异步 EPIPE 由 createCloseRequest 监听。
    return false;
  }
}
