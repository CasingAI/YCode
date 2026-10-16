// 沙盒后台任务管理：任务快照与 waiter 归本管理器，实例生命周期仍由实例表持有。

import type { SandboxEvalRequest, SandboxEvalResult, SessionId } from "@zcode/contracts";
import {
  createSandboxBackgroundTables,
  failSandboxBackgroundEvalsForSession,
  getSandboxBackgroundEval,
  notifySandboxBackgroundWaiters,
  registerSandboxBackgroundEval,
  settleSandboxBackgroundEval,
  waitForSandboxBackgroundEval,
  type SandboxBackgroundEvalSnapshot,
  type SandboxBackgroundTables,
} from "./background-evals.js";
import { SANDBOX_HEAP_LIMIT_BYTES } from "./constants.js";
import type { SandboxInstance } from "./instance.js";
import type { SandboxExecutionRow } from "./execution-rows.js";

interface BackgroundEvalEntry {
  instance: SandboxInstance;
  fresh: boolean;
  executions: SandboxExecutionRow[];
}

interface BackgroundEvalManagerDeps {
  getEntry(sessionId: SessionId): BackgroundEvalEntry | undefined;
  appendExecution(entry: BackgroundEvalEntry, code: string): void;
  saveEntrySnapshot(sessionId: SessionId, entry: BackgroundEvalEntry): Promise<void>;
  disposeEntry(sessionId: SessionId, entry: BackgroundEvalEntry): void;
}

export class SandboxBackgroundEvalManager {
  private readonly tables: SandboxBackgroundTables = createSandboxBackgroundTables();

  constructor(private readonly deps: BackgroundEvalManagerDeps) {}

  start(request: SandboxEvalRequest, entry: BackgroundEvalEntry): string {
    this.deps.appendExecution(entry, request.code);
    const { taskId } = registerSandboxBackgroundEval(this.tables, {
      sessionId: request.sessionId,
      fromSeq: entry.instance.consoleRing.watermark(),
      isFirstResultOnNewInstance: entry.fresh,
    });
    void entry.instance.eval(request.code).then(
      (outcome) => this.finish(request.sessionId, taskId, entry, outcome),
      (error) =>
        this.finish(request.sessionId, taskId, entry, {
          alive: true,
          result: {
            kind: "failed",
            error: {
              code: "Error",
              message: error instanceof Error ? error.message : String(error),
            },
            consoleLines: [],
            consoleTruncated: false,
          },
        }),
    );
    return taskId;
  }

  get(taskId: string): SandboxBackgroundEvalSnapshot | undefined {
    return getSandboxBackgroundEval(this.tables, taskId);
  }

  readConsoleWindow(
    taskId: string,
    input: { filter?: string; limit?: number } = {},
  ): { consoleLines: import("@zcode/contracts").SandboxConsoleLine[]; consoleTruncated: boolean } {
    const snapshot = this.get(taskId);
    const entry = snapshot ? this.deps.getEntry(snapshot.sessionId) : undefined;
    if (!snapshot || !entry) return { consoleLines: [], consoleTruncated: false };
    const window = entry.instance.readConsoleWindow({ fromSeq: snapshot.fromSeq, ...input });
    return { consoleLines: window.lines, consoleTruncated: window.truncated };
  }

  waitFor(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxBackgroundEvalSnapshot | undefined> {
    return waitForSandboxBackgroundEval(this.tables, taskId, options);
  }

  failSession(sessionId: SessionId): void {
    failSandboxBackgroundEvalsForSession(this.tables, sessionId);
  }

  private async finish(
    sessionId: SessionId,
    taskId: string,
    entry: BackgroundEvalEntry,
    outcome: { alive: boolean; result: SandboxEvalResult },
  ): Promise<void> {
    if (!this.get(taskId)) return;
    const isCurrentEntry = this.deps.getEntry(sessionId) === entry;
    if (!isCurrentEntry) {
      settleSandboxBackgroundEval(this.tables, taskId, {
        kind: "failed",
        error: { code: "sandbox_disposed", message: "沙盒实例已销毁" },
      });
      const settled = this.get(taskId);
      if (settled) notifySandboxBackgroundWaiters(this.tables, taskId, settled);
      return;
    }
    if (outcome.result.kind === "completed") {
      if (entry.fresh) entry.fresh = false;
      settleSandboxBackgroundEval(this.tables, taskId, {
        kind: "completed",
        ...(outcome.result.returnText !== undefined
          ? { returnText: outcome.result.returnText }
          : {}),
        ...(outcome.result.consoleTruncated ? { consoleTruncated: true } : {}),
      });
    } else if (outcome.result.kind === "failed") {
      settleSandboxBackgroundEval(this.tables, taskId, {
        kind: "failed",
        error: outcome.result.error,
      });
    } else {
      settleSandboxBackgroundEval(this.tables, taskId, { kind: "other" });
    }
    try {
      if (isCurrentEntry) {
        // 快照保存按存储层约定为非致命；保存异常不能阻断任务 waiter 的终态通知。
        try {
          await this.deps.saveEntrySnapshot(sessionId, entry);
        } catch {
          // 实例仍以内存态为准，后续调用可再次保存。
        }
        const heapBytes = entry.instance.heapBytes();
        if ((heapBytes !== undefined && heapBytes > SANDBOX_HEAP_LIMIT_BYTES) || !outcome.alive) {
          this.deps.disposeEntry(sessionId, entry);
        }
      }
    } finally {
      const settled = this.get(taskId);
      if (settled) notifySandboxBackgroundWaiters(this.tables, taskId, settled);
    }
  }
}

export type { SandboxBackgroundEvalSnapshot, SandboxBackgroundTables };
