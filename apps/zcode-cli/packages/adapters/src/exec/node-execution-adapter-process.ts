import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { BashFileOutput } from "./bash-file-output.js";
import { applyBashSourcesToExecutionRequest } from "./bash-startup-script.js";
import { createBashResourceTelemetry } from "./bash-resource-telemetry.js";
import { createCwdCapturePlan } from "./cwd-capture.js";
import {
  applyResolvedShellCommand,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
import { NodeExecutionAdapterResults } from "./node-execution-adapter-results.js";
import { createExecutionOutputStreamDecoder } from "./outputEncoding.js";
import type { OutputCollector } from "./output-collector.js";
import {
  BASH_SIGTERM_TO_SIGKILL_MS,
  isPosixProcessGroupAlive,
  signalPosixProcessTree,
  terminateGenericPosixProcessGroup,
} from "./process-tree.js";
import {
  revalidateShellInitSnapshotForExecution,
  supportsShellInitSnapshot,
} from "./shell-init-snapshot.js";
import {
  IO_DRAIN_TIMEOUT_MS,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
  waitForPromise,
} from "./execution-utils.js";
import { attachProcessToWindowsJobObject } from "../mcp/windows-job-object.js";
import { awaitWindowsJobGateAllocation } from "./windows-job-gate-allocation.js";
import { spawnWithWindowsJobGate } from "./windows-job-launcher.js";
import type {
  ExecutionSpawnOutcome,
  ExitState,
  InternalExecutionRunOptions,
  PreparedChildSpawn,
  StopReason,
} from "./execution-adapter-types.js";
import type { ExecutionRequest, ExecutionResult, ExecutionRunOptions } from "@zcode/contracts";

export class NodeExecutionAdapterProcess extends NodeExecutionAdapterResults {
  protected trackBashResources(
    child: ChildProcess,
    isBash: boolean,
    stopState: () => { timedOut: boolean; killed: boolean },
  ): (state: ExitState) => void {
    if (!isBash || !this.options.onToolExecResource) return () => {};
    const telemetry = createBashResourceTelemetry({
      platform: this.platform,
      processGroupId: child.pid,
      onComplete: this.options.onToolExecResource,
    });
    return (state) => {
      const stop = stopState();
      telemetry.finish(
        stop.timedOut
          ? "timeout"
          : stop.killed || state.signal
            ? "killed"
            : state.error
              ? "error"
              : "completed",
      );
    };
  }

  protected async prepareChildSpawn(request: ExecutionRequest): Promise<PreparedChildSpawn> {
    const env = buildExecutionEnv(request.env, {
      network: this.options.network,
      platform: this.platform,
      processEnv: this.processEnv,
    });
    const resolvedCommand = resolveExecutionCommand(request.command, {
      cwd: request.cwd,
      env,
      platform: this.platform,
    });
    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const snapshotEnv = resolvedCommand.envOverlay
      ? { ...env, ...resolvedCommand.envOverlay }
      : env;
    const shellInitSnapshot =
      request.command.mode === "shell" &&
      request.command.shellProfile === "posix-bash" &&
      resolvedCommand.shell === false &&
      supportsShellInitSnapshot(resolvedCommand.cwdDialect)
        ? await revalidateShellInitSnapshotForExecution(
            await this.shellInitSnapshots.getOrCreate({
              env: snapshotEnv,
              rootDir,
              shellDialect: resolvedCommand.cwdDialect,
              shellPath: resolvedCommand.file,
            }),
          )
        : undefined;
    const useLoginShell = shellInitSnapshot ? false : true;
    const resolvedShell = setResolvedShellLoginMode(resolvedCommand, useLoginShell);
    const requestWithSources = applyBashSourcesToExecutionRequest(request, {
      leadingSources: shellInitSnapshot
        ? [
            {
              optional: true,
              path: shellInitSnapshot.path,
              shellPath: shellInitSnapshot.shellPath,
            },
          ]
        : [],
      rootDir,
      sessionId,
      shellDialect: resolvedCommand.cwdDialect,
    });
    const capturePlan = createCwdCapturePlan(requestWithSources, {
      dialect: resolvedCommand.cwdDialect,
      platform: this.platform,
    });
    const command =
      capturePlan.command === requestWithSources.command
        ? requestWithSources.command.mode === "shell"
          ? applyResolvedShellCommand(resolvedShell, requestWithSources.command.command)
          : resolvedShell
        : resolveExecutionCommand(capturePlan.command, {
            cwd: request.cwd,
            env,
            platform: this.platform,
            resolvedShell,
          });
    const spawnEnv = command.envOverlay ? { ...env, ...command.envOverlay } : env;
    const baseOptions = {
      cwd: request.cwd,
      detached: this.platform !== "win32",
      env: spawnEnv,
      shell: command.shell,
      stdio: [
        request.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ] satisfies StdioOptions,
      windowsHide: true,
    };

    return {
      command,
      cwdDialect: command.cwdDialect,
      cwdFilePath: capturePlan.cwdFilePath,
      spawnOptions: baseOptions,
    };
  }

  /**
   * Bash 直写文件的限额与进度接线（docs/specs/windows-bash-process-tree-stop.md 之外的既有语义）。
   * 后台化后重新挂载限额观察；只有前台且有事件订阅者时才读取进度尾。
   */
  protected watchBashOutputProgress(args: {
    file: BashFileOutput;
    request: ExecutionRequest;
    options: ExecutionRunOptions;
    internalOptions: InternalExecutionRunOptions;
    startedAt: Date;
    pid: number | undefined;
    isExited: () => boolean;
    isStopRequested: () => boolean;
    requestStop: (reason: StopReason) => void;
  }): void {
    const { file, internalOptions } = args;
    const watchLimit = () => {
      if (args.isExited() || args.isStopRequested()) return;
      file.watchLimit(this.persistedOutputLimit(args.request), () =>
        args.requestStop("output_limit"),
      );
    };
    watchLimit();
    if (internalOptions.bashLifecycle) internalOptions.bashLifecycle.onBackgrounded = watchLimit;
    if (
      !args.options.onEvent ||
      args.isExited() ||
      internalOptions.bashLifecycle?.isBackgrounded()
    ) {
      return;
    }
    file.watchProgress(
      this.progressTailBytes,
      this.progressThresholdMs,
      this.progressIntervalMs,
      (output, outputPreview) => {
        this.emit(args.options, {
          type: "progress",
          elapsedMs: Date.now() - args.startedAt.getTime(),
          pid: args.pid,
          stdoutBytes: output.bytes,
          stderrBytes: 0,
          stdoutTail: output.text,
          outputPreview,
          timestamp: new Date(),
        });
      },
    );
  }

  /** 通用 pipe 模式的周期进度事件；Bash 直写文件走 watchBashOutputProgress。 */
  protected startPipedProgressTimer(args: {
    stdout: OutputCollector;
    stderr: OutputCollector;
    options: ExecutionRunOptions;
    internalOptions: InternalExecutionRunOptions;
    startedAt: Date;
    pid: number | undefined;
    isClosed: () => boolean;
    isExited: () => boolean;
  }): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (
        args.isClosed() ||
        (args.isExited() && args.internalOptions.shouldRetainExecutionAfterRootExit?.() !== true)
      )
        return;
      const elapsedMs = Date.now() - args.startedAt.getTime();
      if (elapsedMs < this.progressThresholdMs) return;
      this.emit(args.options, {
        type: "progress",
        elapsedMs,
        pid: args.pid,
        stdoutBytes: args.stdout.bytes,
        stderrBytes: args.stderr.bytes,
        stdoutTail: args.stdout.tailText(),
        stderrTail: args.stderr.tailText(),
        timestamp: new Date(),
      });
    }, this.progressIntervalMs);
    timer.unref?.();
    return timer;
  }

  /**
   * 启动真实命令（docs/specs/windows-bash-process-tree-stop.md）。
   *
   * Windows 上先起启动器，并在放行前完成作业分配，避免「spawn 已开始运行、attach 还没到」
   * 的窗口：真实命令从创建的第一刻就是作业成员，快速退出也逃不掉。不放行时真实命令从未
   * 启动，调用方会把预建的空输出文件一起丢弃。
   */
  protected async startExecutionChild(args: {
    prepared: PreparedChildSpawn;
    isStopRequested: () => boolean;
    stoppedResult: () => ExecutionResult;
    unavailable: (message: string) => ExecutionResult;
    discardOutput: () => Promise<void>;
  }): Promise<ExecutionSpawnOutcome> {
    const attachWindowsJob = (pid: number | undefined) =>
      this.platform === "win32" && pid !== undefined
        ? (
            this.options.windowsJobObjectFactory ??
            ((targetPid: number) => attachProcessToWindowsJobObject(targetPid))
          )(pid).catch(() => undefined)
        : undefined;

    const gate = spawnWithWindowsJobGate(args.prepared);
    if (!gate) {
      // 非 Windows：沿用既有直接 spawn + 进程组路径。Windows 上闸门起不来会直接抛错，
      // 由调用方还原成 spawn_error，不会走到这里。
      const child = spawn(
        args.prepared.command.file,
        args.prepared.command.args,
        args.prepared.spawnOptions,
      );
      return { kind: "spawned", child, job: attachWindowsJob(child.pid) };
    }

    const allocation = await awaitWindowsJobGateAllocation({
      gate,
      attachJob: (pid) => attachWindowsJob(pid) ?? Promise.resolve(undefined),
      isStopRequested: args.isStopRequested,
      stoppedResult: args.stoppedResult,
      unavailable: args.unavailable,
    });
    if (allocation.kind === "result") {
      // 真实命令从未启动，预建的空输出文件必须丢弃，避免留下无主产物。
      await args.discardOutput();
      return { kind: "result", result: allocation.result };
    }
    gate.release();
    // 真实命令由启动器 spawn；失败必须还原成 spawn_error，不能表现为启动器退出 127。
    return {
      kind: "spawned",
      child: gate.child,
      job: allocation.job,
      commandStart: gate.commandStart,
    };
  }

  /**
   * 结算时回收本次执行仍存活的后代（docs/specs/windows-bash-process-tree-stop.md）。
   *
   * root 退出意味着这次 execution 已经结算：无论它是前台命令还是正式后台任务，
   * 派生树里没有被其它任务接管的进程都必须终止。Windows 由调用方先 TerminateJobObject；
   * 这里只补两件事：
   * - 作业不可用（原生模块失败/闸门退化）时，用 taskkill /T 兜底；
   * - POSIX Bash 复用既有独立进程组与 PPID 快照清理。
   * 通用 argv/hook 的退出语义不在本规范范围内，仍由 drainChildOutput 的既有路径处理。
   */
  protected reclaimProcessTreeOnSettlement(
    child: ChildProcess,
    useBashProcessTreeStop: boolean,
    windowsJobAttached: boolean,
  ): void {
    if (!child.pid) return;
    if (this.platform === "win32") {
      // 作业覆盖时 TerminateJobObject 已终止全部成员；只有作业不可用才需要 taskkill。
      if (!windowsJobAttached) this.terminateProcessTree(child, useBashProcessTreeStop);
      return;
    }
    if (!useBashProcessTreeStop) return;
    // 正常结算时进程组通常已随 root 退出消失；没有存活成员就不必排 1.5s 的两阶段等待。
    if (!isPosixProcessGroupAlive(child.pid)) return;
    this.killBashPosixProcessTree(child.pid);
  }

  /** POSIX Bash 的两阶段清理，停止与结算共用，避免重复实现。 */
  protected killBashPosixProcessTree(rootPid: number): void {
    // Bash job control、pipeline、xargs 和 PTY 可以把 worker 放入不同 PGID。
    // 两阶段清理各自快照当时的 PPID 后代，不跨阶段记忆进程身份。
    void signalPosixProcessTree(rootPid, "SIGTERM");
    let timer!: NodeJS.Timeout;
    const escalation = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          process.kill(-rootPid, "SIGKILL");
        } catch {
          // 直接的 force group kill 只做 best effort，随后仍会执行完整杀树。
        }
        // shutdown 等待实际查表与信号发送，不能在异步杀树刚启动时就释放清理所有权。
        void signalPosixProcessTree(rootPid, "SIGKILL").then(resolve);
      }, BASH_SIGTERM_TO_SIGKILL_MS);
      timer.unref?.();
    });
    this.pendingBashProcessTreeKills.set(escalation, timer);
    void escalation.finally(() => {
      this.pendingBashProcessTreeKills.delete(escalation);
    });
  }

  protected terminateProcessTree(child: ChildProcess, useBashProcessTreeStop: boolean): void {
    if (!child.pid) {
      child.kill("SIGTERM");
      return;
    }

    if (this.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const completion = new Promise<void>((resolve) => {
        killer.once("error", () => {
          child.kill("SIGKILL");
          resolve();
        });
        killer.once("close", () => resolve());
      });
      if (useBashProcessTreeStop) {
        // 直写后不再等待 pipe EOF，shutdown 必须显式等待 taskkill 收尾，避免提前释放资源。
        this.pendingBashProcessTreeKills.set(completion, killer);
        void completion.finally(() => this.pendingBashProcessTreeKills.delete(completion));
      }
      return;
    }

    if (!useBashProcessTreeStop) {
      // PPID 后代枚举只修复 Bash job-control 的跨 PGID 清理；通用 hook、
      // shell 和 argv execution 必须保留既有进程组边界，避免修复能力扩散到其它调用方。
      terminateGenericPosixProcessGroup(child);
      return;
    }

    this.killBashPosixProcessTree(child.pid);
  }

  protected destroyChildOutputStreams(child: ChildProcess): void {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  protected attachPipedOutput(
    child: ChildProcess,
    stdout: OutputCollector,
    stderr: OutputCollector,
    encoding: string | null,
    options: ExecutionRunOptions,
  ): void {
    for (const [name, collector] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const stream = child[name];
      const decoder = createExecutionOutputStreamDecoder(encoding);
      stream?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        collector.append(buffer, stream);
        this.emit(options, {
          type: name,
          chunk: buffer,
          text: decoder.write(buffer),
          timestamp: new Date(),
        });
      });
    }
  }

  protected writeChildInput(
    child: ChildProcess,
    input: ExecutionRequest["stdin"],
  ): () => Error | undefined {
    let failure: Error | undefined;
    if (input !== undefined && child.stdin) {
      const capture = (error: Error) => {
        failure ??= error;
      };
      // Hook 可以提前关闭 stdin，异步 EPIPE 必须有监听，不能让 Agent 崩溃。
      child.stdin.on("error", capture);
      try {
        child.stdin.end(input);
      } catch (error) {
        capture(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return () => failure;
  }

  protected async drainChildOutput(
    child: ChildProcess,
    closed: Promise<void>,
    options: InternalExecutionRunOptions,
    terminationRequested: boolean,
  ): Promise<void> {
    if (await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS)) return;
    // 通用 argv/Hook 保留 pipe EOF 所有权；Bash 直写文件不会进入此路径。
    if (options.shouldRetainExecutionAfterRootExit?.() === true) {
      await closed;
      return;
    }
    if (!terminationRequested) this.terminateProcessTree(child, false);
    if (!(await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS))) this.destroyChildOutputStreams(child);
  }
}
