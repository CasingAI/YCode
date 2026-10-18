/**
 * History 只读旁路调度：进程内同时只跑一个 worker；用完 terminate。
 * 取消时杀掉当前线程并拒绝排队作业。见 docs/specs/session-history-tools.md。
 */
import { Worker } from "node:worker_threads";
import type {
  IsolatedHistoryJob,
  IsolatedHistoryJobResult,
} from "@zcode/contracts";
import { DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS } from "./migration-runner.js";
import {
  isHistoryReadLaneWorkerMessage,
  type HistoryReadLaneWorkerData,
} from "./history-read-lane-protocol.js";
import { historyReadLaneWorkerUrl } from "./history-read-lane-worker-url.js";

export { historyReadLaneWorkerUrl } from "./history-read-lane-worker-url.js";

export function canOpenHistoryReadLane(dbPath: string): boolean {
  const trimmed = dbPath.trim();
  if (trimmed === "" || trimmed === ":memory:") return false;
  return true;
}

export interface HistoryReadLaneOptions {
  dbPath: string;
  timeoutMs?: number;
  workerUrl?: URL;
  /** 仅供队列测试注入；生产走工作线程。 */
  executeJob?: (
    job: IsolatedHistoryJob,
    signal: AbortSignal,
  ) => Promise<IsolatedHistoryJobResult>;
}

interface QueuedHistoryJob {
  job: IsolatedHistoryJob;
  signal: AbortSignal;
  resolve: (result: IsolatedHistoryJobResult) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

function historyLaneAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("History read lane aborted", "AbortError");
}

function settleQueued(
  queued: QueuedHistoryJob,
  action: "resolve" | "reject",
  value: IsolatedHistoryJobResult | unknown,
): void {
  if (queued.settled) return;
  queued.settled = true;
  if (action === "resolve") queued.resolve(value as IsolatedHistoryJobResult);
  else queued.reject(value);
}

export class HistoryReadLane {
  readonly stats = { maxObservedActive: 0, active: 0 };
  private readonly pending: QueuedHistoryJob[] = [];
  private running:
    | { queued: QueuedHistoryJob; worker: Worker | undefined; abort: () => void }
    | undefined;
  private disposed = false;

  constructor(private readonly options: HistoryReadLaneOptions) {}

  enqueue(
    job: IsolatedHistoryJob,
    signal?: AbortSignal,
  ): Promise<IsolatedHistoryJobResult> {
    const abortSignal = signal ?? new AbortController().signal;
    return new Promise((resolve, reject) => {
      if (this.disposed || abortSignal.aborted) {
        reject(historyLaneAbortError(abortSignal));
        return;
      }
      const queued: QueuedHistoryJob = {
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
          settleQueued(queued, "reject", historyLaneAbortError(queued.signal));
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
      settleQueued(item, "reject", historyLaneAbortError(item.signal));
    }
    this.running?.abort();
  }

  private pump(): void {
    if (this.running || this.disposed) return;
    const next = this.pending.shift();
    if (!next) return;
    if (next.signal.aborted) {
      settleQueued(next, "reject", historyLaneAbortError(next.signal));
      this.pump();
      return;
    }
    this.stats.active += 1;
    this.stats.maxObservedActive = Math.max(this.stats.maxObservedActive, this.stats.active);
    let handle: ReturnType<HistoryReadLane["startJob"]>;
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

  private finishJob(queued: QueuedHistoryJob): void {
    this.stats.active = Math.max(0, this.stats.active - 1);
    if (this.running?.queued === queued) this.running = undefined;
    this.pump();
  }

  private startJob(queued: QueuedHistoryJob): {
    promise: Promise<IsolatedHistoryJobResult>;
    worker: Worker | undefined;
    abort: () => void;
  } {
    if (this.options.executeJob) {
      const executeJob = this.options.executeJob;
      let rejectExecute: (error: unknown) => void = () => undefined;
      const promise = new Promise<IsolatedHistoryJobResult>((resolve, reject) => {
        rejectExecute = reject;
        void executeJob(queued.job, queued.signal).then(resolve, reject);
      });
      return {
        promise,
        worker: undefined,
        abort: () => rejectExecute(historyLaneAbortError(queued.signal)),
      };
    }
    return this.startWorker(queued);
  }

  private startWorker(queued: QueuedHistoryJob): {
    promise: Promise<IsolatedHistoryJobResult>;
    worker: Worker;
    abort: () => void;
  } {
    const workerUrl = this.options.workerUrl ?? historyReadLaneWorkerUrl();
    const workerData: HistoryReadLaneWorkerData = {
      dbPath: this.options.dbPath,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
      job: queued.job,
    };
    const worker = new Worker(workerUrl, { workerData });
    let aborted = false;
    let settled = false;
    let resolvePromise: (result: IsolatedHistoryJobResult) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<IsolatedHistoryJobResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      run();
    };
    const abort = () => {
      aborted = true;
      finish(() => rejectPromise(historyLaneAbortError(queued.signal)));
    };
    worker.on("message", (message: unknown) => {
      if (isHistoryReadLaneWorkerMessage(message) && message.type === "telemetry") {
        (process.emit as (eventName: string, ...args: unknown[]) => boolean)(
          "zcode:disk-io-worker-batch",
          message.batch,
        );
        return;
      }
      if (!isHistoryReadLaneWorkerMessage(message)) {
        finish(() => rejectPromise(new Error("History read lane worker returned an invalid message")));
        return;
      }
      if (message.type === "done") {
        finish(() => resolvePromise(message.result));
        return;
      }
      if (message.type === "error") {
        const errorInfo = message;
        finish(() =>
          rejectPromise(
            Object.assign(new Error(errorInfo.message), { name: errorInfo.name ?? "Error" }),
          ),
        );
      }
    });
    worker.once("error", (error) => finish(() => rejectPromise(error)));
    worker.once("exit", (code) => {
      if (aborted) {
        finish(() => rejectPromise(historyLaneAbortError(queued.signal)));
        return;
      }
      if (code !== 0) {
        finish(() =>
          rejectPromise(new Error(`History read lane worker exited with code ${code}`)),
        );
      }
    });
    worker.unref();
    if (queued.signal.aborted) abort();
    return { promise, worker, abort };
  }
}

export function createHistoryReadLane(options: HistoryReadLaneOptions): HistoryReadLane {
  return new HistoryReadLane(options);
}
