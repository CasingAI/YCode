/**
 * 沙盒只读 SQLite 查询调度：进程内同时只跑一个 worker；用完 terminate。
 * 取消时杀掉当前线程并拒绝排队作业。见 docs/specs/sandbox-system-tool.md「宿主 SQLite」。
 *
 * 不能在主线程跑查询：node:sqlite 没有中断 / 超时 / AbortSignal 入口，
 * 慢查询会占住 event loop，导致 stop 和超时没法 terminate。
 * 放到 Worker 后，超时与取消都能从主线程 terminate 这个执行单元。
 */
import { Worker } from "node:worker_threads";
import type {
  SqliteReadLaneJob,
  SqliteReadLaneJobResult,
  SqliteReadLaneWorkerData,
} from "./read-lane-protocol.js";
import { isSqliteReadLaneWorkerMessage } from "./read-lane-protocol.js";
import { sqliteReadLaneWorkerUrl } from "./read-lane-worker-url.js";

export { sqliteReadLaneWorkerUrl } from "./read-lane-worker-url.js";

export interface SqliteReadLaneOptions {
  timeoutMs?: number;
  maxRows?: number;
  maxResultBytes?: number;
  workerUrl?: URL;
  /** 仅供队列测试注入；生产走工作线程。 */
  executeJob?: (job: SqliteReadLaneJob, signal: AbortSignal) => Promise<SqliteReadLaneJobResult>;
}

export const DEFAULT_SQLITE_READ_LANE_TIMEOUT_MS = 10_000;
export const DEFAULT_SQLITE_READ_LANE_MAX_ROWS = 10_000;
export const DEFAULT_SQLITE_READ_LANE_MAX_RESULT_BYTES = 4 * 1024 * 1024;

interface QueuedSqliteJob {
  job: SqliteReadLaneJob;
  signal: AbortSignal;
  resolve: (result: SqliteReadLaneJobResult) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

function sqliteLaneAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Sqlite read lane aborted", "AbortError");
}

function settleQueued(
  queued: QueuedSqliteJob,
  action: "resolve" | "reject",
  value: SqliteReadLaneJobResult | unknown,
): void {
  if (queued.settled) return;
  queued.settled = true;
  if (action === "resolve") queued.resolve(value as SqliteReadLaneJobResult);
  else queued.reject(value);
}

export class SqliteReadLane {
  readonly stats = { maxObservedActive: 0, active: 0 };
  private readonly pending: QueuedSqliteJob[] = [];
  private running:
    | { queued: QueuedSqliteJob; worker: Worker | undefined; abort: () => void }
    | undefined;
  private disposed = false;

  constructor(private readonly options: SqliteReadLaneOptions = {}) {}

  enqueue(job: SqliteReadLaneJob, signal?: AbortSignal): Promise<SqliteReadLaneJobResult> {
    const abortSignal = signal ?? new AbortController().signal;
    return new Promise((resolve, reject) => {
      if (this.disposed || abortSignal.aborted) {
        reject(sqliteLaneAbortError(abortSignal));
        return;
      }
      const queued: QueuedSqliteJob = {
        job,
        signal: abortSignal,
        resolve,
        reject,
        settled: false,
      };
      const onAbort = () => {
        if (this.running?.queued === queued) {
          this.running.abort();
          return;
        }
        const index = this.pending.indexOf(queued);
        if (index >= 0) {
          this.pending.splice(index, 1);
          settleQueued(queued, "reject", sqliteLaneAbortError(queued.signal));
        }
      };
      abortSignal.addEventListener("abort", onAbort);
      this.pending.push(queued);
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    const pending = this.pending.splice(0);
    for (const item of pending) {
      settleQueued(item, "reject", sqliteLaneAbortError(item.signal));
    }
    this.running?.abort();
  }

  private pump(): void {
    if (this.running || this.disposed) return;
    const next = this.pending.shift();
    if (!next) return;
    if (next.signal.aborted) {
      settleQueued(next, "reject", sqliteLaneAbortError(next.signal));
      this.pump();
      return;
    }
    this.stats.active += 1;
    this.stats.maxObservedActive = Math.max(this.stats.maxObservedActive, this.stats.active);
    let handle: ReturnType<SqliteReadLane["startJob"]>;
    try {
      handle = this.startJob(next);
    } catch (error) {
      this.finishJob(next);
      settleQueued(next, "reject", error);
      return;
    }
    this.running = { queued: next, worker: handle.worker, abort: handle.abort };
    void handle.promise.then(
      (result) => {
        this.finishJob(next);
        settleQueued(next, "resolve", result);
      },
      (error) => {
        this.finishJob(next);
        settleQueued(next, "reject", error);
      },
    );
  }

  private finishJob(queued: QueuedSqliteJob): void {
    this.stats.active = Math.max(0, this.stats.active - 1);
    if (this.running?.queued === queued) this.running = undefined;
    this.pump();
  }

  private startJob(queued: QueuedSqliteJob): {
    promise: Promise<SqliteReadLaneJobResult>;
    worker: Worker | undefined;
    abort: () => void;
  } {
    if (this.options.executeJob) {
      const executeJob = this.options.executeJob;
      let rejectExecute: (error: unknown) => void = () => undefined;
      const promise = new Promise<SqliteReadLaneJobResult>((resolve, reject) => {
        rejectExecute = reject;
        void executeJob(queued.job, queued.signal).then(resolve, reject);
      });
      return {
        promise,
        worker: undefined,
        abort: () => rejectExecute(sqliteLaneAbortError(queued.signal)),
      };
    }
    return this.startWorker(queued);
  }

  private startWorker(queued: QueuedSqliteJob): {
    promise: Promise<SqliteReadLaneJobResult>;
    worker: Worker;
    abort: () => void;
  } {
    const workerUrl = this.options.workerUrl ?? sqliteReadLaneWorkerUrl();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SQLITE_READ_LANE_TIMEOUT_MS;
    const workerData: SqliteReadLaneWorkerData = {
      timeoutMs,
      maxRows: this.options.maxRows ?? DEFAULT_SQLITE_READ_LANE_MAX_ROWS,
      maxResultBytes: this.options.maxResultBytes ?? DEFAULT_SQLITE_READ_LANE_MAX_RESULT_BYTES,
      job: queued.job,
    };
    const worker = new Worker(workerUrl, { workerData });
    let aborted = false;
    let settled = false;
    let resolvePromise: (result: SqliteReadLaneJobResult) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<SqliteReadLaneJobResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      run();
    };
    // 主线程超时兜底：worker 内无中断入口，超时只能 terminate 整个线程。
    const timer = setTimeout(
      () =>
        finish(() =>
          rejectPromise(
            Object.assign(new Error(`Sqlite read lane timed out after ${timeoutMs}ms`), {
              name: "SqliteReadLaneTimeoutError",
              code: "timed_out",
            }),
          ),
        ),
      timeoutMs,
    );
    // 超时计时器不得钉住进程退出。
    timer.unref?.();
    const abort = () => {
      aborted = true;
      finish(() => rejectPromise(sqliteLaneAbortError(queued.signal)));
    };
    worker.on("message", (message: unknown) => {
      if (isSqliteReadLaneWorkerMessage(message) && message.type === "telemetry") {
        (process.emit as (eventName: string, ...args: unknown[]) => boolean)(
          "zcode:disk-io-worker-batch",
          message.batch,
        );
        return;
      }
      if (!isSqliteReadLaneWorkerMessage(message)) {
        finish(() =>
          rejectPromise(new Error("Sqlite read lane worker returned an invalid message")),
        );
        return;
      }
      if (message.type === "done") {
        finish(() => resolvePromise(message.result));
        return;
      }
      if (message.type === "error") {
        const errorInfo = message.error;
        finish(() =>
          rejectPromise(
            Object.assign(new Error(errorInfo.message), {
              name: errorInfo.name ?? "Error",
              code: errorInfo.code,
              errcode: errorInfo.errcode,
            }),
          ),
        );
      }
    });
    worker.once("error", (error) => finish(() => rejectPromise(error)));
    worker.once("exit", (code) => {
      if (aborted) {
        finish(() => rejectPromise(sqliteLaneAbortError(queued.signal)));
        return;
      }
      if (code !== 0) {
        finish(() => rejectPromise(new Error(`Sqlite read lane worker exited with code ${code}`)));
      }
    });
    worker.unref();
    if (queued.signal.aborted) abort();
    return { promise, worker, abort };
  }
}

export function createSqliteReadLane(options?: SqliteReadLaneOptions): SqliteReadLane {
  return new SqliteReadLane(options ?? {});
}
