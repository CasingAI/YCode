import type { ChildProcess } from "node:child_process";
import { BashFileOutput } from "./bash-file-output.js";
import { defaultCwdDialect } from "./execution-command.js";
import { NodeExecutionAdapterProcess } from "./node-execution-adapter-process.js";
import { resolveLegacyExecutionOutputEncoding } from "./outputEncoding.js";
import {
  DEFAULT_TIMEOUT_MS,
  FORCE_EXIT_AFTER_KILL_MS,
  abortSignalReason,
  isBashMergedOutputRequest,
} from "./execution-utils.js";
import { registerSessionProcess, unregisterSessionProcess } from "./session-process-registry.js";
import { createChildExitTracking } from "./child-exit-tracking.js";
import type { WindowsJobObjectController } from "../mcp/windows-job-object.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  StopReason,
} from "./execution-adapter-types.js";
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
} from "@zcode/contracts";
import { lowerProcessPriority } from "@zcode/shared/node";

export class NodeExecutionAdapterRun extends NodeExecutionAdapterProcess {
  async run(
    request: ExecutionRequest,
    options: ExecutionRunOptions = {},
  ): Promise<ExecutionResult> {
    const startedAt = new Date();
    const useBashMergedOutput = isBashMergedOutputRequest(request);
    let requestStop: (reason: StopReason) => void = () => undefined;
    let outputLimitExceeded = false;
    const internalOptions = options as InternalExecutionRunOptions;
    const aggregatePersistedBudget = internalOptions.sharePersistedOutputLimitAcrossStreams
      ? {
          bytes: 0,
          maxBytes: Math.max(0, this.persistedOutputLimit(request)),
        }
      : undefined;

    if (this.closePromise) {
      return this.createStoppedResult(startedAt, "cancelled", "Execution adapter is shutting down");
    }

    if (options.signal?.aborted) {
      return this.createStoppedResult(startedAt, "cancelled", "Execution cancelled before spawn");
    }

    let persistedLimitNotified = false;
    const onPersistedLimit =
      request.outputLimit?.killProcessOnPersistedLimit === true ||
      internalOptions.onPersistedLimit ||
      internalOptions.shouldStopOnPersistedLimit
        ? () => {
            if (persistedLimitNotified) return;
            persistedLimitNotified = true;
            internalOptions.onPersistedLimit?.();
            if (
              request.outputLimit?.killProcessOnPersistedLimit === true ||
              internalOptions.shouldStopOnPersistedLimit?.() === true
            ) {
              requestStop("output_limit");
            }
          }
        : undefined;
    const legacyOutputEncoding = resolveLegacyExecutionOutputEncoding({
      platform: this.platform,
      processEnv: this.processEnv,
    });
    // 任务记录单独解析会重复同步执行 Windows chcp；复用执行时的编码值。
    internalOptions.onOutputEncodingResolved?.(legacyOutputEncoding);
    const file = useBashMergedOutput
      ? new BashFileOutput(
          this.outputPathForRequest(request, "stdout")!,
          this.platform,
          legacyOutputEncoding,
        )
      : undefined;
    const stdout = file
      ? undefined
      : this.createOutputCollector(
          request,
          "stdout",
          legacyOutputEncoding,
          onPersistedLimit,
          aggregatePersistedBudget,
        );
    const stderr = file
      ? undefined
      : this.createOutputCollector(
          request,
          "stderr",
          legacyOutputEncoding,
          onPersistedLimit,
          aggregatePersistedBudget,
        );
    let child: ChildProcess | undefined;
    let cwdDialect: ExecutionShellDialect = defaultCwdDialect(this.platform);
    let cwdFilePath: string | undefined;
    let timedOut = false;
    let cancelled = false;
    let exited = false;
    let childClosed = false;
    let executionSettled = false;
    let childReadyForTermination = false;
    let terminationRequested = false;
    let stopRequested = false;
    let forceExitTimer: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let finishExit: (state: ExitState) => void = () => undefined;
    let finishResourceTelemetry: (state: ExitState) => void = () => undefined;
    // timeout 计时器在 spawn 后才启动（见下），spawn 前的停止只可能来自取消或 adapter 关闭。
    const createPreSpawnStoppedResult = () =>
      this.createStoppedResult(
        startedAt,
        "cancelled",
        this.closePromise
          ? "Execution adapter is shutting down"
          : "Execution cancelled before spawn",
      );
    const stoppedBeforeSpawn = (): ExecutionResult | undefined => {
      if (!stopRequested && !this.closePromise && !options.signal?.aborted) return undefined;
      return createPreSpawnStoppedResult();
    };
    /**
     * Windows 作业闸门不可用（原生 Job 缺失、分配失败/超期、启动器起不来）时，
     * 不放出真实命令，直接返回明确的 spawn_error：静默执行等于放弃整树所有权保证。
     */
    const finishGateUnavailable = (
      runOptions: ExecutionRunOptions,
      start: Date,
      message: string,
    ): ExecutionResult => {
      const result = this.createOwnershipUnavailableResult({
        startedAt: start,
        message,
        stdout: stdout?.result() ?? { text: "", bytes: 0, truncated: false },
        stderr: stderr?.result() ?? { text: "", bytes: 0, truncated: false },
      });
      this.emitResult(runOptions, result);
      return result;
    };

    // 作业控制器在 spawn 之后才就绪；停止请求可能先到，先记下意图再在控制器到位后执行。
    let windowsJobSettled = false;
    let windowsJobSettlePromise: Promise<boolean> | undefined;
    let windowsJobPromise: Promise<WindowsJobObjectController | undefined> | undefined;
    // 返回本次执行是否真的持有作业：结算时据此决定是否需要 taskkill 兜底。
    const settleWindowsJob = (terminate: boolean): Promise<boolean> => {
      if (windowsJobSettled) return windowsJobSettlePromise ?? Promise.resolve(false);
      windowsJobSettled = true;
      windowsJobSettlePromise = (windowsJobPromise ?? Promise.resolve(undefined)).then((job) => {
        if (!job) return false;
        if (terminate) {
          try {
            job.terminate();
          } catch {
            // 原生终止失败时保留既有 terminateProcessTree 兜底。
          }
        }
        try {
          job.close();
        } catch {
          // 句柄关闭失败不能改变命令结果。
        }
        return true;
      });
      return windowsJobSettlePromise;
    };

    const terminateStartedChild = () => {
      if (!stopRequested) return;
      // Windows 的 taskkill /T 沿当前父子链查找。root 先退出或已被中间 shell 替换时，
      // 后代已经 reparent，/T 找不到它们；Job Object 记录成员身份，停止时按成员整树终止。
      settleWindowsJob(true);
      if (!child || !childReadyForTermination || terminationRequested) {
        return;
      }
      const startedChild = child;
      terminationRequested = true;
      // root shell exit 不代表其进程组和继承 pipe 的后代已经退出。
      // cancel/close 必须在组长 exit 后仍能清理整个 execution，避免 orphan。
      this.terminateProcessTree(startedChild, useBashMergedOutput);
      if (file) {
        finishExit({ code: timedOut ? 143 : 137 });
        return;
      }
      forceExitTimer = setTimeout(() => {
        if (!exited) {
          finishExit({
            signal: "SIGKILL",
          });
        }
        // Windows 的 taskkill 或 POSIX 的 PGID 都可能已无法寻址脱离的后代；
        // 最终释放 ZCode 持有的读端，不能继续让未知进程保活 CLI。
        this.destroyChildOutputStreams(startedChild);
      }, FORCE_EXIT_AFTER_KILL_MS);
      forceExitTimer.unref?.();
    };

    requestStop = (reason: StopReason) => {
      // root 已退出但执行仍保留（后台任务）时，作业里可能还有存活后代；
      // 不能因为 file && exited 就跳过停止，否则 TaskStop 只改状态、进程继续跑。
      if (
        executionSettled ||
        stopRequested ||
        (file && exited && internalOptions.shouldRetainExecutionAfterRootExit?.() !== true)
      ) {
        return;
      }
      stopRequested = true;
      if (reason === "timeout") {
        timedOut = true;
      } else if (reason === "cancelled") {
        cancelled = true;
      } else {
        outputLimitExceeded = true;
      }
      terminateStartedChild();
    };

    const executionId = this.registerActiveExecution(requestStop);
    const abortHandler = () => {
      const reason = abortSignalReason(options.signal);
      requestStop(reason === "output_limit" ? "output_limit" : "cancelled");
    };
    if (options.signal?.aborted) {
      requestStop("cancelled");
    } else {
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      const prepared = await this.prepareChildSpawn(request);

      // shell init snapshot 创建是异步的；用户可能在等待期间取消或关闭 adapter。

      const stoppedAfterCommandPreparation = stoppedBeforeSpawn();
      if (stoppedAfterCommandPreparation) {
        return stoppedAfterCommandPreparation;
      }

      if (file) {
        await file.prepare();
        const stoppedAfterOutputPreparation = stoppedBeforeSpawn();
        if (stoppedAfterOutputPreparation) {
          await file.discard();
          return stoppedAfterOutputPreparation;
        }
        prepared.spawnOptions.stdio = [
          request.stdin === undefined ? "ignore" : "pipe",
          file.fd!,
          file.fd!,
        ];
      }

      // 启动准备与闸门等待在 process 层完成；run() 只消费「已启动」或「启动阶段已结算」。
      const outcome = await this.startExecutionChild({
        prepared,
        isStopRequested: () => stopRequested || this.closePromise !== undefined,
        stoppedResult: createPreSpawnStoppedResult,
        unavailable: (message) => finishGateUnavailable(options, startedAt, message),
        discardOutput: () => file?.discard() ?? Promise.resolve(),
      });
      if (outcome.kind === "result") return outcome.result;
      const spawnedChild = outcome.child;
      const gateStartResult = outcome.commandStart;
      windowsJobPromise = outcome.job;
      child = spawnedChild;
      lowerProcessPriority(spawnedChild.pid, "idle");
      // 资源管理器：登记“这次执行属于哪个会话”，Host 侧据此把进程树归属到会话。
      registerSessionProcess(spawnedChild.pid ?? 0, request.trace?.sessionId);
      finishResourceTelemetry = this.trackBashResources(spawnedChild, useBashMergedOutput, () => ({
        timedOut,
        killed: cancelled || outputLimitExceeded,
      }));
      cwdDialect = prepared.cwdDialect;
      cwdFilePath = prepared.cwdFilePath;

      // 结局的所有权仍在本执行器：幂等标记、资源遥测结束与 Bash 生命周期回调都在这里，
      // child-exit-tracking 只负责把事件翻译成「谁先到达就谁落定」。
      const finalizeExit = (state: ExitState) => {
        if (exited) return;
        exited = true;
        finishResourceTelemetry(state);
        file?.stopWatching();
        if (file) internalOptions.bashLifecycle?.onExit?.();
      };
      finishExit = finalizeExit;
      const tracking = createChildExitTracking(spawnedChild, {
        gateStartResult,
        onStartError: () => unregisterSessionProcess(spawnedChild.pid),
        onExit: () => unregisterSessionProcess(spawnedChild.pid),
        onClosed: () => {
          childClosed = true;
        },
        finalize: finalizeExit,
      });
      const exitPromise = tracking.exitPromise;
      const closePromise = tracking.closePromise;
      // 启动器报告真实命令启动失败时，补一个 spawn_error 结局；成功与失败都由 exit 兜底。
      if (gateStartResult) {
        void gateStartResult.then((start) => {
          if (!start.ok) tracking.finish({ error: new Error(start.message) });
        });
      }

      await file?.close();
      if (file) {
        this.watchBashOutputProgress({
          file,
          request,
          options,
          internalOptions,
          startedAt,
          pid: spawnedChild.pid,
          isExited: () => exited,
          isStopRequested: () => stopRequested,
          requestStop,
        });
      }
      childReadyForTermination = true;
      terminateStartedChild();

      this.emit(options, { type: "started", pid: spawnedChild.pid, timestamp: startedAt });

      // 复原原因：计时器提前到准备阶段是 protected-resource sandbox 时代的行为——capability
      // probe 可能无限挂起，总超时必须覆盖准备期。sandbox 撤除后准备阶段只剩 shell snapshot /
      // artifact 等既有异步步骤，timeoutMs 恢复为只约束子进程运行，避免 shell 初始化较慢或
      // timeout 较短时命令尚未启动就被判 timed_out；准备期间的取消与关闭仍由 stoppedBeforeSpawn 兜底。
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => requestStop("timeout"), timeoutMs);
      }

      if (stdout && stderr) {
        if (options.onEvent) {
          progressTimer = this.startPipedProgressTimer({
            stdout,
            stderr,
            options,
            internalOptions,
            startedAt,
            pid: spawnedChild.pid,
            isClosed: () => childClosed,
            isExited: () => exited,
          });
        }
        this.attachPipedOutput(spawnedChild, stdout, stderr, legacyOutputEncoding, options);
      }
      const inputFailure = this.writeChildInput(spawnedChild, request.stdin);

      const exitState = await exitPromise;
      // root 已退出即进入结算：本次执行不再被任何任务持有，作业里的存活后代必须回收。
      // Windows 由 TerminateJobObject 覆盖 detached/reparent 的成员；POSIX 复用进程组与 PPID 快照。
      const windowsJobAttached = await settleWindowsJob(true);
      this.reclaimProcessTreeOnSettlement(spawnedChild, useBashMergedOutput, windowsJobAttached);
      if (!file) {
        await this.drainChildOutput(
          spawnedChild,
          closePromise,
          internalOptions,
          terminationRequested,
        );
        await Promise.all([stdout!.close(), stderr!.close()]);
      } else if (exitState.error) {
        await file.discard();
      }
      const stdoutResult = file
        ? await this.readBashResult(file, request, internalOptions, exitState, outputLimitExceeded)
        : stdout!.result();
      const stderrResult = useBashMergedOutput
        ? { text: "", bytes: 0, truncated: false }
        : stderr!.result();
      const result = this.assembleExecutionResult({
        startedAt,
        completedAt: new Date(),
        pid: spawnedChild.pid,
        exitState,
        timedOut,
        cancelled,
        outputLimitExceeded,
        timeoutMs,
        bashMergedOutput: useBashMergedOutput,
        stdout: stdoutResult,
        stderr: stderrResult,
        stdinWriteError: inputFailure(),
        cwd: { filePath: cwdFilePath, dialect: cwdDialect },
      });

      this.emitResult(options, result);
      return result;
    } catch (error) {
      if (!child) await file?.discard();
      if (stopRequested || this.closePromise || options.signal?.aborted) {
        return createPreSpawnStoppedResult();
      }
      const result = this.createSpawnFailureResult({
        startedAt,
        error,
        stdout: file ? await file.result(this.bashInlineLimit(request)) : stdout!.result(),
        stderr: useBashMergedOutput ? { text: "", bytes: 0, truncated: false } : stderr!.result(),
      });
      this.emitResult(options, result);
      return result;
    } finally {
      if (!exited)
        finishResourceTelemetry({ error: new Error("Execution ended before child exit") });
      executionSettled = true;
      // 任何离开 run() 的路径都是这次 execution 的结算：作业必须终止并关闭，
      // 不能把仍存活的成员留在内核里等下一个任务来认领。结算路径已处理过时这里只是幂等返回。
      settleWindowsJob(true);
      file?.stopWatching();
      if (internalOptions.bashLifecycle) internalOptions.bashLifecycle.onBackgrounded = undefined;
      await file?.close();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (progressTimer) clearInterval(progressTimer);
      if (forceExitTimer) clearTimeout(forceExitTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      this.completeActiveExecution(executionId);
    }
  }
}
