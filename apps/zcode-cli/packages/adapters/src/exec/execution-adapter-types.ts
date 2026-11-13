import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { ZCodeToolExecResource } from "@zcode/shared";
import type { NetworkEgressEnvPolicy } from "../network/subprocess-env.js";
import type { WindowsJobObjectController } from "../mcp/windows-job-object.js";
import type { ResolvedSpawnCommand } from "./execution-command.js";
import type { LauncherStartResult } from "./job-launcher-command.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
} from "@zcode/contracts";

export interface ExitState {
  code?: number;
  signal?: string;
  error?: Error;
}

export interface BackgroundTaskRecord extends BackgroundExecutionSnapshot {
  sessionId?: string;
  isBash: boolean;
  legacyOutputEncoding: string | null;
  /** 创建时从 ExecutionRequest 取一次的只读快照；详情面板据此显示「在跑什么」。 */
  command?: string;
  cwd?: string;
  completion: Promise<BackgroundExecutionSnapshot>;
  controller: AbortController;
  externalAbort?: () => void;
  resolveCompletion: (snapshot: BackgroundExecutionSnapshot) => void;
}

export interface ExecutionOutputPaths {
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
}

export interface InternalExecutionRunOptions extends ExecutionRunOptions {
  onOutputEncodingResolved?: (encoding: string | null) => void;
  /** Bash 移交时停止前台预览并重启文件 watchdog；不复制进程或输出。 */
  bashLifecycle?: {
    isBackgrounded: () => boolean;
    onBackgrounded?: () => void;
    onExit?: () => void;
  };
  onPersistedLimit?: () => void;
  sharePersistedOutputLimitAcrossStreams?: boolean;
  shouldStopOnPersistedLimit?: () => boolean;
  shouldRetainExecutionAfterRootExit?: () => boolean;
}

export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout";

export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };

export interface PreparedChildSpawn {
  command: ResolvedSpawnCommand;
  cwdDialect: ExecutionShellDialect;
  cwdFilePath?: string;
  spawnOptions: SpawnOptions;
}

export interface ActiveExecutionRecord {
  completion: Promise<void>;
  resolveCompletion: () => void;
  stop: (reason: StopReason) => void;
}

/**
 * 启动一次执行的结果（docs/specs/windows-bash-process-tree-stop.md）：
 * `spawned` 表示真实命令已（可）运行；`result` 表示本次执行在启动阶段就已结算。
 */
export type ExecutionSpawnOutcome =
  | { kind: "result"; result: ExecutionResult }
  | {
      kind: "spawned";
      child: ChildProcess;
      job: Promise<WindowsJobObjectController | undefined> | undefined;
      commandStart?: Promise<LauncherStartResult>;
    };

export interface NodeExecutionAdapterOptions {
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  outputRootDir?: string;
  maxPersistedOutputBytes?: number;
  network?: NetworkEgressEnvPolicy;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  progressIntervalMs?: number;
  progressTailBytes?: number;
  progressThresholdMs?: number;
  /** 测试注入；默认在 win32 上把执行 root 挂进 Job Object。 */
  windowsJobObjectFactory?: (pid: number) => Promise<WindowsJobObjectController | undefined>;
}

export type OutputPersistenceMode = "none" | "on_truncate" | "always";

export type StopReason = "timeout" | "cancelled" | "output_limit";
