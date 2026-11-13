import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { BashFileOutput, diagnoseLostBashOutput } from "./bash-file-output.js";
import { readCapturedCwd } from "./cwd-capture.js";
import { NodeExecutionAdapterBase } from "./node-execution-adapter-base.js";
import {
  DEFAULT_TIMEOUT_MS,
  formatTimeoutDuration,
  isExpectedChildStdinClosureError,
} from "./execution-utils.js";
import type {
  ExecutionOutputPaths,
  InternalExecutionRunOptions,
  ExitState,
  OutputPersistenceMode,
} from "./execution-adapter-types.js";
import type {
  ExecutionEvent,
  ExecutionFailure,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
  ExecutionStatus,
  ExecutionStreamResult,
} from "@zcode/contracts";

export class NodeExecutionAdapterResults extends NodeExecutionAdapterBase {
  /**
   * 装配一次执行的结果（docs/specs/windows-bash-process-tree-stop.md）。
   *
   * 状态裁决全部留在 results 层：执行器只提供事实（退出、超时、取消、输出），
   * 避免 run() 同时承担事件接线、进程树回收与结果推导。
   */
  protected assembleExecutionResult(args: {
    startedAt: Date;
    completedAt: Date;
    pid: number | undefined;
    exitState: ExitState;
    timedOut: boolean;
    cancelled: boolean;
    outputLimitExceeded: boolean;
    timeoutMs: number;
    /** Bash 直写模式：输出超限时的失败文案与通用 pipe 不同。 */
    bashMergedOutput: boolean;
    stdout: ExecutionStreamResult;
    stderr: ExecutionStreamResult;
    stdinWriteError: Error | undefined;
    cwd?: { filePath: string | undefined; dialect: ExecutionShellDialect };
  }): ExecutionResult {
    const cancelled = args.bashMergedOutput && args.outputLimitExceeded ? true : args.cancelled;
    const baseStatus = this.statusFromExit(
      args.exitState,
      args.timedOut,
      cancelled,
      args.outputLimitExceeded,
    );
    const unexpectedStdinFailure =
      baseStatus === "completed" &&
      args.stdinWriteError &&
      !isExpectedChildStdinClosureError(args.stdinWriteError)
        ? this.toFailure("unknown", args.stdinWriteError)
        : undefined;
    const failure = args.exitState.error
      ? this.toFailure("spawn_error", args.exitState.error)
      : args.bashMergedOutput && args.outputLimitExceeded
        ? { type: "output_limit" as const, message: "Command killed: output file exceeded 5GB" }
        : (this.statusFailure(args.timedOut, cancelled, args.outputLimitExceeded, args.timeoutMs) ??
          unexpectedStdinFailure);
    const status = unexpectedStdinFailure ? "failed" : baseStatus;
    const resolvedCwd =
      status === "completed" && args.exitState.code === 0 && args.cwd?.filePath
        ? readCapturedCwd(args.cwd.filePath, { dialect: args.cwd.dialect })
        : undefined;
    return this.createResult({
      status,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      pid: args.pid,
      exitCode: args.exitState.code,
      signal: args.exitState.signal,
      stdout: args.stdout,
      stderr: args.stderr,
      timedOut: args.timedOut,
      cancelled,
      error: failure,
      resolvedCwd,
    });
  }

  /**
   * 进程树所有权不可用时的明确失败结果：命令未启动，不能宣称任何回收保证。
   */
  protected createOwnershipUnavailableResult(args: {
    startedAt: Date;
    stdout: ExecutionStreamResult;
    stderr: ExecutionStreamResult;
    message: string;
  }): ExecutionResult {
    return this.createSpawnFailureResult({ ...args, error: new Error(args.message) });
  }

  /** spawn 阶段失败（启动器/直接 spawn 抛错）的统一结果形态。 */
  protected createSpawnFailureResult(args: {
    startedAt: Date;
    error: unknown;
    stdout: ExecutionStreamResult;
    stderr: ExecutionStreamResult;
  }): ExecutionResult {
    return this.createResult({
      status: "spawn_error",
      startedAt: args.startedAt,
      completedAt: new Date(),
      stdout: args.stdout,
      stderr: args.stderr,
      timedOut: false,
      cancelled: false,
      error: this.toFailure("spawn_error", args.error),
    });
  }

  protected emitResult(options: ExecutionRunOptions, result: ExecutionResult): void {
    if (result.status === "spawn_error" && result.error) {
      this.emit(options, { type: "failed", error: result.error, timestamp: result.completedAt });
    } else {
      this.emit(options, { type: "completed", result, timestamp: result.completedAt });
    }
  }

  protected async readBashResult(
    file: BashFileOutput,
    request: ExecutionRequest,
    options: InternalExecutionRunOptions,
    exit: ExitState,
    outputLimitExceeded: boolean,
  ): Promise<ExecutionStreamResult> {
    let result = await file.result(this.bashInlineLimit(request));
    if (
      !options.bashLifecycle?.isBackgrounded() &&
      (outputLimitExceeded || !options.bashLifecycle)
    ) {
      result = await this.normalizeBashBackgroundLifecycleForegroundStream(
        result,
        file.path,
        undefined,
        outputLimitExceeded ? "none" : (request.outputLimit?.persistOutput ?? "none"),
      );
    }
    // 仅对空输出且非零退出进行文件系统诊断，不把正常无输出命令误报为丢失。
    if (result.text === "" && exit.code !== undefined && exit.code !== 0 && exit.code !== 137) {
      const diagnostic = await diagnoseLostBashOutput(file.path);
      if (diagnostic) result = { ...result, text: diagnostic };
    }
    return result;
  }

  protected async ensureBackgroundOutputFiles(paths: ExecutionOutputPaths): Promise<void> {
    for (const path of new Set([
      paths.outputPath,
      paths.stdoutPersistedOutputPath,
      paths.stderrPersistedOutputPath,
    ])) {
      if (!path) continue;
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "a", 0o600);
      await handle.close();
    }
  }

  protected async normalizeBashBackgroundLifecycleForegroundResult(
    result: ExecutionResult,
    paths: ExecutionOutputPaths,
    originalMaxArtifactBytes: number | undefined,
    originalPersistOutput: OutputPersistenceMode,
  ): Promise<ExecutionResult> {
    return {
      ...result,
      stderr: await this.normalizeBashBackgroundLifecycleForegroundStream(
        result.stderr,
        paths.stderrPersistedOutputPath,
        originalMaxArtifactBytes,
        originalPersistOutput,
      ),
      stdout: await this.normalizeBashBackgroundLifecycleForegroundStream(
        result.stdout,
        paths.stdoutPersistedOutputPath,
        originalMaxArtifactBytes,
        originalPersistOutput,
      ),
    };
  }

  protected async normalizeBashBackgroundLifecycleForegroundStream(
    stream: ExecutionStreamResult,
    path: string | undefined,
    originalMaxArtifactBytes: number | undefined,
    originalPersistOutput: OutputPersistenceMode,
  ): Promise<ExecutionStreamResult> {
    const shouldKeepArtifact =
      originalPersistOutput === "always"
        ? stream.artifactPath !== undefined
        : originalPersistOutput === "on_truncate" && stream.truncated;
    // Bash 直写保留完整原始文件；仅通用 pipe 执行在结算时应用 artifact 预算。
    if (shouldKeepArtifact && originalMaxArtifactBytes === undefined) return stream;
    if (
      shouldKeepArtifact &&
      originalMaxArtifactBytes !== undefined &&
      originalMaxArtifactBytes > 0
    ) {
      return await this.capForegroundArtifactStream(stream, path, originalMaxArtifactBytes);
    }

    if (path) {
      try {
        await rm(path, { force: true });
      } catch {
        // foreground lifecycle 的主结算曾与 artifact 清理耦合，删除异常会让
        // outcome 永久悬空。清理仅是 best-effort；结果仍按 foreground 契约隐藏冗余路径。
      }
    }
    if (
      stream.artifactPath === undefined &&
      stream.artifactBytes === undefined &&
      stream.artifactTruncated === undefined
    ) {
      return stream;
    }
    return {
      ...stream,
      artifactBytes: undefined,
      artifactPath: undefined,
      artifactTruncated: undefined,
    };
  }

  protected async capForegroundArtifactStream(
    stream: ExecutionStreamResult,
    path: string | undefined,
    maxBytes: number,
  ): Promise<ExecutionStreamResult> {
    if (!path || stream.artifactBytes === undefined || stream.artifactBytes <= maxBytes) {
      return stream;
    }
    try {
      const handle = await open(path, "r+");
      try {
        await handle.truncate(maxBytes);
      } finally {
        await handle.close();
      }
    } catch {
      // 截断失败不能阻塞已经完成的命令；保留真实 artifact 元数据，避免伪报已截断。
      return stream;
    }
    return {
      ...stream,
      artifactBytes: maxBytes,
      artifactTruncated: true,
    };
  }

  protected normalizeBashBackgroundOutputLimitResult(
    result: ExecutionResult,
    persistedLimitReached: boolean,
  ): ExecutionResult {
    if (!persistedLimitReached) return result;
    return {
      ...result,
      status: "cancelled",
      exitCode: 137,
      timedOut: false,
      cancelled: true,
      error: {
        type: "output_limit",
        message: "Background command killed: output file exceeded 5GB",
      },
    };
  }

  protected statusFromExit(
    exitState: ExitState,
    timedOut: boolean,
    cancelled: boolean,
    outputLimitExceeded = false,
  ): ExecutionStatus {
    if (exitState.error) return "spawn_error";
    if (timedOut) return "timed_out";
    if (cancelled) return "cancelled";
    if (outputLimitExceeded) return "failed";
    return exitState.code === 0 ? "completed" : "failed";
  }

  protected statusFailure(
    timedOut: boolean,
    cancelled: boolean,
    outputLimitExceeded = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): ExecutionFailure | undefined {
    if (timedOut) {
      return {
        type: "timeout",
        message: `Command timed out after ${formatTimeoutDuration(timeoutMs)}`,
      };
    }
    if (cancelled) {
      return { type: "cancelled", message: "Execution cancelled" };
    }
    if (outputLimitExceeded) {
      return {
        type: "output_limit",
        message: "Execution output exceeded the persisted output limit",
      };
    }
    return undefined;
  }

  protected createStoppedResult(
    startedAt: Date,
    status: ExecutionStatus,
    message: string,
  ): ExecutionResult {
    const completedAt = new Date();
    const failureType =
      status === "cancelled" ? "cancelled" : status === "timed_out" ? "timeout" : "spawn_error";
    return this.createResult({
      status,
      startedAt,
      completedAt,
      stdout: { text: "", bytes: 0, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      timedOut: status === "timed_out",
      cancelled: status === "cancelled",
      error: { type: failureType, message },
    });
  }

  protected createResult(args: {
    status: ExecutionStatus;
    startedAt: Date;
    completedAt: Date;
    stdout: ExecutionStreamResult;
    stderr: ExecutionStreamResult;
    timedOut: boolean;
    cancelled: boolean;
    pid?: number;
    exitCode?: number;
    signal?: string;
    error?: ExecutionFailure;
    resolvedCwd?: string;
  }): ExecutionResult {
    return {
      status: args.status,
      exitCode: args.exitCode,
      signal: args.signal,
      stdout: args.stdout,
      stderr: args.stderr,
      durationMs: args.completedAt.getTime() - args.startedAt.getTime(),
      timedOut: args.timedOut,
      cancelled: args.cancelled,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      pid: args.pid,
      error: args.error,
      resolvedCwd: args.resolvedCwd,
    };
  }

  protected toFailure(type: ExecutionFailure["type"], error: unknown): ExecutionFailure {
    if (error instanceof Error) {
      return {
        type,
        message: error.message,
        cause: error,
      };
    }

    return {
      type,
      message: String(error),
      cause: error,
    };
  }

  protected emit(options: ExecutionRunOptions, event: ExecutionEvent): void {
    if (!options.onEvent) return;
    void Promise.resolve(options.onEvent(event)).catch(() => undefined);
  }
}
