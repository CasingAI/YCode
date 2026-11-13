import { interceptTuiStderr, isTuiInvocation } from "./tui-stderr.js";
import { interceptKnownRuntimeWarnings } from "./runtime-warnings.js";
import { installStderrConsoleBoundary } from "./protocol-console.js";
import { setCliProcessTitle } from "./process-name.js";
import { applyCliRuntimeEnvSanitization } from "./env.js";
import { ensureSeaRuntimeTools } from "./sea-runtime-tools.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { scheduleCliExitWatchdog } from "./shutdown.js";
import { installCliProcessErrorBoundary } from "./process-errors.js";
import { installProtocolStderrBoundary } from "./protocol-stderr.js";
import { createProtocolProcessLifecycle } from "./protocol-lifecycle.js";
import { isProtocolServerInvocation } from "./arguments.js";
import { isBrowserHostInvocation, isJobLauncherInvocation } from "./internal-commands.js";
import { applyCliProcessPriority } from "./process-priority.js";

void main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // 入口角色决定优先级；--prepare-storage 可能运行在 Host Worker 内，必须跳过。
  applyCliProcessPriority(argv);
  // 存储模式也可运行在 Host Worker 中，不能修改整个 Host 的进程名称。
  if (!argv.includes("--prepare-storage")) setCliProcessTitle();
  // Linux 浏览器宿主必须在加载 run/bootstrap 和 Playwright 之前分派；它按 stdin 存活，
  // 不能走一次性 CLI exit watchdog。宿主继承父 CLI 已清洗过的环境。
  if (isBrowserHostInvocation(argv)) {
    try {
      const { runBrowserHostCommand } = await import("./browser-host-command.js");
      process.exitCode = await runBrowserHostCommand(
        { argv, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
        argv.slice(1),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  // Windows 执行 Job 启动器：SEA 单文件只能走本二进制 + 内部命令自 re-exec。
  // 必须在加载 run/bootstrap 之前分派，且只依赖 adapters 公开入口；它按 IPC 存活。
  if (isJobLauncherInvocation(argv)) {
    // adapters 公开入口会间接执行到 node:sqlite，其 ExperimentalWarning 早于本函数稍后
    // 安装的全局抑制器输出，会被父方当作命令输出捕获。加载前先复用同一抑制器。该警告在
    // runJobLauncherCommand 返回后才异步写出，故不能在返回时 restore；launch 进程专用于
    // 启动子命令，自身 stderr 不承载用户输出，而真实命令继承父进程的 stderr 句柄、
    // 不经过本进程的 write，所以目标命令自己的警告不受影响。
    interceptKnownRuntimeWarnings(process.stderr);
    try {
      const { runJobLauncherCommand } = await import("@zcode/adapters/exec");
      process.exitCode = await runJobLauncherCommand();
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  // 真实 zcode CLI 进程里仍可能有少量路径直接读取 process.env。
  // 入口先清洗用户 shell 注入的 NODE_ENV、代理和证书变量；网络变量只封存给后续 Bash/tool 子进程恢复。
  applyCliRuntimeEnvSanitization(process.env);
  const isProtocol = isProtocolServerInvocation(argv);
  const isTui = isTuiInvocation(argv);
  if (isProtocol) installProtocolStderrBoundary(process.stderr);
  const lifecycle =
    isProtocol && !argv.includes("--prepare-storage")
      ? createProtocolProcessLifecycle()
      : undefined;
  // app-server/agent-server 的 stdout 是严格的 ZCode Protocol 帧通道，三方 SDK 的
  // console.debug 等普通输出不能直接写入 stdout。必须在加载 run/bootstrap 之前将
  // 进程级 console 统一引导到 stderr，否则任意依赖的一行普通日志都会触发传输层 JSON 解析崩溃。
  // TUI 同样独占 stdout；AI SDK 的首条提示使用 console.info，不能绕过 stderr 捕获。
  const restoreConsole =
    isProtocol || isTui ? installStderrConsoleBoundary(process.stderr) : undefined;
  const runtimeWarnings = interceptKnownRuntimeWarnings(process.stderr);
  const tuiStderr = isTui ? interceptTuiStderr(process.stderr) : undefined;
  const stderr = tuiStderr?.passthrough ?? process.stderr;
  const disposeProcessErrorBoundary = isProtocol
    ? installCliProcessErrorBoundary({
        stderr,
        onFatal: (reason) => {
          if (lifecycle)
            lifecycle.requestShutdown(new Error("Uncaught process error", { cause: reason }));
          else process.exit(1);
        },
      })
    : undefined;

  try {
    if (!argv.includes("--prepare-storage"))
      Object.assign(process.env, await ensureSeaRuntimeTools());
    lifecycle?.signal.throwIfAborted();
    const context = {
      argv,
      stderr,
      stdin: process.stdin,
      stdout: process.stdout,
    };
    // plugin-host 只承载插件；先导入 run 会求值 Agent、工具注册表和工作流模块，
    // 即使最终没有创建 AgentRuntime，也会让每个 MCP 子进程持有整套业务依赖。
    if (isPluginHostInvocation(argv)) {
      process.exitCode = await runPluginHostCommand(context, argv.slice(1));
      return;
    }
    if (!argv.includes("--prepare-storage")) {
      const { prepareCliProviderRuntimeEnv } = await import("./provider-runtime-env.js");
      Object.assign(
        process.env,
        await prepareCliProviderRuntimeEnv({
          argv,
          env: process.env,
        }),
      );
    }
    lifecycle?.signal.throwIfAborted();
    const { run } = await import("./run.js");
    lifecycle?.signal.throwIfAborted();
    const exitCode = await run(context, {
      protocolLifecycle: lifecycle,
      protocolInput: lifecycle?.input,
    });

    process.exitCode = exitCode;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await waitForPendingWarnings();
    // 生命周期和 stderr guard 一直保留到实际退出，迟到的错误不能恢复递归写坏流。
    if (lifecycle) {
      await lifecycle.complete(normalizeProcessExitCode(process.exitCode));
    } else {
      if (tuiStderr) {
        tuiStderr.restore();
      }
      runtimeWarnings.restore();
      disposeProcessErrorBoundary?.();
      // plugin-host 的 main() 在 MCP server.connect() 完成后会返回，但此时
      // stdio handle 正是服务的存活条件。一次性 CLI watchdog 不能把它误判为泄漏并强退。
      const exitCode = normalizeProcessExitCode(process.exitCode);
      if (!isPluginHostInvocation(argv) || exitCode !== 0) {
        scheduleCliExitWatchdog({ exitCode });
      }
      restoreConsole?.();
    }
  }
}

function normalizeProcessExitCode(exitCode: string | number | null | undefined): number {
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
  if (typeof exitCode === "string") {
    const parsed = Number(exitCode);
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
}

function waitForPendingWarnings(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
