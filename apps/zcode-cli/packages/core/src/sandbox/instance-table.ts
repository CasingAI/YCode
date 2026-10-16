// ============================================================
// Sandbox 实例表：每 sessionId 一份活实例的唯一所有者
// ============================================================
// 子代理自己的 sessionId 自然隔离（key 即 sessionId，不做父子映射）。
// 新建实例后的第一次 eval 返回 isFirstResultOnNewInstance=true，调用方
// （阶段2的工具 handler）据此包一次新实例提示，只写一次。
//
// 内存硬顶：每次 eval 后观测堆占用，超 128MB 即销毁实例（杀 VM）；
// 下次调用建新实例 + 提示。LocalStorage 内存态在销毁前落盘（阶段1同步落盘已有）。

import type {
  FileSystemPort,
  HttpClientPort,
  SandboxEvalOptions,
  SandboxEvalRequest,
  SandboxEvalResult,
  SandboxPort,
  SessionId,
  SqliteReadPort,
} from "@zcode/contracts";
import type { SandboxFsHostPaths } from "./fs-host-context.js";
import type { SandboxSqliteHostPaths } from "./sqlite-host-context.js";
import { buildSandboxInstanceHosts } from "./table-host-contexts.js";
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
import { resolveSandboxLocalStoragePath, SANDBOX_HEAP_LIMIT_BYTES } from "./constants.js";
import { appendSandboxExecutionRow, type SandboxExecutionRow } from "./execution-rows.js";
import { SandboxInstance } from "./instance.js";
import { saveSandboxLocalStorageSnapshot } from "./local-storage-store.js";

export type { SandboxBackgroundEvalSnapshot, SandboxBackgroundTables, SandboxExecutionRow };
export { SANDBOX_BACKGROUND_TASK_ID_PREFIX } from "./background-evals.js";
export {
  SANDBOX_EXECUTION_CODE_MAX_CHARS,
  SANDBOX_EXECUTION_PREVIEW_MAX_CHARS,
} from "./execution-rows.js";

export interface SandboxTableDeps {
  /** cliStorageRoot 缺席时实例仍可跑（内存态），只跳过磁盘落盘/灌回。 */
  cliStorageRoot?: string;
  fileSystemPort?: FileSystemPort;
  /** 按 sessionId 现读 mode / cwd / 工作区根；缺席时 FS 调用拒绝（实例仍可跑计算）。 */
  resolveFsHost?: (sessionId: SessionId) => SandboxFsHostPaths | undefined;
  /** 按 sessionId 现读 HTTP 端口；缺席时 fetch 拒绝（实例仍可跑计算与 FS）。 */
  resolveFetchHost?: (sessionId: SessionId) => HttpClientPort | undefined;
  /** 沙盒只读 SQLite 查询端口；缺席时 sqlite 查询拒绝（实例仍可跑其余能力）。 */
  sqliteReadPort?: SqliteReadPort;
  /** 按 sessionId 现读 SQLite 宿主路径；缺席时复用 FS 宿主路径。 */
  resolveSqliteHost?: (sessionId: SessionId) => SandboxSqliteHostPaths | undefined;
}

interface TableEntry {
  instance: SandboxInstance;
  fresh: boolean;
  /** 控制台执行行（控制台 tab 的展示行；随实例死亡消失，不持久化）。 */
  executions: SandboxExecutionRow[];
}

/** 测试/存储扫描导出已迁移到同目录模块，见 execution-rows.ts。 */

export class SandboxInstanceTable implements SandboxPort {
  private readonly entries = new Map<SessionId, TableEntry>();
  private readonly creating = new Map<SessionId, Promise<SandboxInstance>>();
  private readonly background: SandboxBackgroundTables = createSandboxBackgroundTables();

  private nextExecutionSeq = 1;

  constructor(private readonly deps: SandboxTableDeps = {}) {}

  /** 落盘依赖注入（runtime 装配时调用；直接赋值，undefined 即清除）。 */
  configureDeps(deps: SandboxTableDeps): void {
    this.deps.cliStorageRoot = deps.cliStorageRoot;
    this.deps.fileSystemPort = deps.fileSystemPort;
    this.deps.resolveFsHost = deps.resolveFsHost;
    this.deps.resolveFetchHost = deps.resolveFetchHost;
    this.deps.sqliteReadPort = deps.sqliteReadPort;
    this.deps.resolveSqliteHost = deps.resolveSqliteHost;
  }

  async eval(
    request: SandboxEvalRequest,
    options?: SandboxEvalOptions,
  ): Promise<{
    result: SandboxEvalResult;
    instanceAlive: boolean;
    isFirstResultOnNewInstance: boolean;
  }> {
    return this.evalWithSource(request, "model", options);
  }

  /**
   * 带执行行来源的 eval 内核（模型工具调用记 model，控制台用户 eval 记 user）。
   * 公开仅供同一目录的 user-eval 模块复用同一条执行路径，不另开第二条执行态。
   */
  async evalWithSource(
    request: SandboxEvalRequest,
    executionSource: SandboxExecutionRow["source"],
    options?: SandboxEvalOptions,
  ): Promise<{
    result: SandboxEvalResult;
    instanceAlive: boolean;
    isFirstResultOnNewInstance: boolean;
  }> {
    if (request.resetBeforeRun === true) await this.reset(request.sessionId);
    // 阶段1只实现同步 eval：后台/超时摘等待由阶段4的工具层承担，端口收到即拒绝。
    if (request.runInBackground === true) {
      return {
        result: {
          kind: "failed",
          error: { code: "sandbox_not_implemented", message: "后台执行尚未实现（阶段4）" },
          consoleLines: [],
          consoleTruncated: false,
        },
        instanceAlive: this.hasLiveInstance(request.sessionId),
        isFirstResultOnNewInstance: false,
      };
    }
    const entry = await this.getOrCreate(request.sessionId, options?.signal);
    // 控制台执行行记录传入源码，不持久化；实例销毁后随堆一起释放。
    const appended = appendSandboxExecutionRow(
      entry.executions,
      this.nextExecutionSeq,
      executionSource,
      request.code,
    );
    this.nextExecutionSeq = appended.nextSeq;
    // 原因与修复依据：模型走语句语义（`return` 协议），用户走 DevTools 语义（先表达
    // 式后语句回退）；结算后的落盘/硬顶/坏 VM 处理两条路径共用，不分叉。
    const outcome =
      executionSource === "user"
        ? await entry.instance.evalUser(request.code)
        : await entry.instance.eval(request.code);
    return this.finishEval(request, entry, outcome, options?.signal);
  }

  /** eval 结算后的共用收尾：落盘、堆硬顶、坏 VM 丢弃；提示位只在成功消耗。 */
  private async finishEval(
    request: SandboxEvalRequest,
    entry: TableEntry,
    outcome: { result: import("@zcode/contracts").SandboxEvalResult; alive: boolean },
    signal?: AbortSignal,
  ): Promise<{
    result: import("@zcode/contracts").SandboxEvalResult;
    instanceAlive: boolean;
    isFirstResultOnNewInstance: boolean;
  }> {
    // 原因与修复依据：spec「只写这一次（以成功为准）」——第一次若失败，提示位保留，
    // 下一次成功调用仍带，不因失败消耗。失败调用仍标记 isFirst=true，由调用方
    // （工具 handler）把提示拼进错误文本，模型在失败里也能看到新实例提示。
    const succeeded = outcome.result.kind === "completed";
    const isFirst = entry.fresh;
    if (succeeded) entry.fresh = false;
    await saveSandboxLocalStorageSnapshot({
      cliStorageRoot: this.deps.cliStorageRoot,
      fileSystemPort: this.deps.fileSystemPort,
      sessionId: request.sessionId,
      snapshot: entry.instance.localStorage.snapshot(),
      signal,
    });
    // 堆硬顶：超了销毁整份实例（ LocalStorage 已落盘保留）。
    const heapBytes = entry.instance.heapBytes();
    if (heapBytes !== undefined && heapBytes > SANDBOX_HEAP_LIMIT_BYTES) {
      this.dispose(request.sessionId);
      return { result: outcome.result, instanceAlive: false, isFirstResultOnNewInstance: isFirst };
    }
    if (!outcome.alive) {
      // VM 已坏：丢弃条目，下次调用建新实例。
      this.dispose(request.sessionId);
    }
    return {
      result: outcome.result,
      instanceAlive: outcome.alive,
      isFirstResultOnNewInstance: isFirst,
    };
  }

  async readConsoleWindow(
    sessionId: SessionId,
    input: { fromSeq?: number; sinceMs?: number; filter?: string; limit?: number },
  ): Promise<{ lines: import("@zcode/contracts").SandboxConsoleLine[]; truncated: boolean }> {
    const entry = this.entries.get(sessionId);
    if (!entry) return { lines: [], truncated: false };
    const window = entry.instance.readConsoleWindow(input);
    if (input.sinceMs === undefined) return window;
    const lines = window.lines.filter((line) => line.at >= (input.sinceMs as number));
    return { lines, truncated: window.truncated };
  }

  /**
   * 重置实例：销毁旧实例并立即新建一个干净实例；LocalStorage 保留；在途调用按失败结算。
   * 幂等：对不存在的实例执行同样产出可用新实例（dispose 缺席即 no-op，随后 getOrCreate 建新）。
   * 重建失败直接抛，由调用方按领域失败语义收口（不返回半初始化实例）。
   */
  async reset(sessionId: SessionId): Promise<void> {
    this.dispose(sessionId);
    await this.getOrCreate(sessionId);
  }

  // -----------------------------------------------
  // 后台执行（阶段4）：显式后台 + 超时自动摘后台共用
  // -----------------------------------------------
  // 语义对齐 Bash 的「摘走」而不是「杀掉」：启动即返回 ID，JS 在活实例里继续跑；
  // TaskOutput 按 taskId 读窗口 console + return。停止从不打断 JS（见 stopBackgroundTask
  // 的 local_sandbox 分支：cancel_not_supported，只能重置实例）。

  /** 启动一次后台 eval，返回 taskId（`sandbox_` 前缀，避免与 `exec_*` 混）。 */
  async startBackgroundEval(
    request: SandboxEvalRequest,
    options?: SandboxEvalOptions,
  ): Promise<{ taskId: string } | { error: { code: string; message: string } }> {
    if (request.resetBeforeRun === true) await this.reset(request.sessionId);
    const entry = await this.getOrCreate(request.sessionId, options?.signal);
    // 控制台执行行：源码就绪即追加（与前台 eval 同轨道）。
    const appended = appendSandboxExecutionRow(
      entry.executions,
      this.nextExecutionSeq,
      "model",
      request.code,
    );
    this.nextExecutionSeq = appended.nextSeq;
    // 新实例提示位：启动时只读取不消耗（以成功为准，见 finishEval）；
    // 后台结算成功才消耗 fresh，失败保留给下一次成功调用。
    const isFirstResultOnNewInstance = entry.fresh;
    const { taskId } = registerSandboxBackgroundEval(this.background, {
      sessionId: request.sessionId,
      fromSeq: entry.instance.consoleRing.watermark(),
      isFirstResultOnNewInstance,
    });
    // 后台跑：不等待，结算时更新状态 + 落盘 + 唤醒 waiter。JS 继续跑，不受调用方 abort 影响
    // （停止从不打断 JS；调用方取消只放弃等待，见 handler 层的 abort 处理）。
    void entry.instance.eval(request.code).then(
      async (outcome) => {
        await this.finishBackgroundEval(request, taskId, outcome);
      },
      async (error) => {
        await this.finishBackgroundEval(request, taskId, {
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
        });
      },
    );
    return { taskId };
  }

  /** 后台执行的快照（TaskOutput 投影与 lifecycleProvider 快照源的事实源）。 */
  getBackgroundEval(taskId: string): SandboxBackgroundEvalSnapshot | undefined {
    return getSandboxBackgroundEval(this.background, taskId);
  }

  /** 后台执行的 console 增量窗口（该次调用开始 → 现在；filter 只留命中行）。 */
  readConsoleWindowForBackground(
    taskId: string,
    input: { filter?: string; limit?: number } = {},
  ): { consoleLines: import("@zcode/contracts").SandboxConsoleLine[]; consoleTruncated: boolean } {
    const snapshot = getSandboxBackgroundEval(this.background, taskId);
    const entry = snapshot ? this.entries.get(snapshot.sessionId) : undefined;
    if (!snapshot || !entry) return { consoleLines: [], consoleTruncated: false };
    const window = entry.instance.readConsoleWindow({ fromSeq: snapshot.fromSeq, ...input });
    return { consoleLines: window.lines, consoleTruncated: window.truncated };
  }

  /** 等待后台执行终态（TaskOutput block=true 用；abort 即返回当前快照）。 */
  waitForBackgroundEval(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxBackgroundEvalSnapshot | undefined> {
    return waitForSandboxBackgroundEval(this.background, taskId, options);
  }

  private async finishBackgroundEval(
    request: SandboxEvalRequest,
    taskId: string,
    outcome: { alive: boolean; result: SandboxEvalResult },
  ): Promise<void> {
    const snapshot = getSandboxBackgroundEval(this.background, taskId);
    if (!snapshot) return;
    const entry = this.entries.get(request.sessionId);
    if (outcome.result.kind === "completed") {
      // 原因与修复依据：后台提示位同样以成功为准——结算成功才消耗 fresh，
      // 失败保留给下一次调用（与前台 finishEval 同语义）。
      if (entry?.fresh === true) entry.fresh = false;
      settleSandboxBackgroundEval(this.background, taskId, {
        kind: "completed",
        ...(outcome.result.returnText !== undefined
          ? { returnText: outcome.result.returnText }
          : {}),
        ...(outcome.result.consoleTruncated ? { consoleTruncated: true } : {}),
      });
    } else if (outcome.result.kind === "failed") {
      settleSandboxBackgroundEval(this.background, taskId, {
        kind: "failed",
        error: outcome.result.error,
      });
    } else {
      settleSandboxBackgroundEval(this.background, taskId, { kind: "other" });
    }
    // 结算后落盘 LocalStorage（内存态为准）；实例死亡则该 taskId 后续读取失败。
    if (entry) {
      await saveSandboxLocalStorageSnapshot({
        cliStorageRoot: this.deps.cliStorageRoot,
        fileSystemPort: this.deps.fileSystemPort,
        sessionId: request.sessionId,
        snapshot: entry.instance.localStorage.snapshot(),
      });
      const heapBytes = entry.instance.heapBytes();
      if (heapBytes !== undefined && heapBytes > SANDBOX_HEAP_LIMIT_BYTES)
        this.dispose(request.sessionId);
      if (!outcome.alive) this.dispose(request.sessionId);
    }
    const settled = getSandboxBackgroundEval(this.background, taskId);
    if (settled) notifySandboxBackgroundWaiters(this.background, taskId, settled);
  }

  dispose(sessionId: SessionId): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    entry.instance.dispose();
    // 实例死亡：该会话的后台 ID 全部失效（旧 ID 读取失败），waiter 按终态唤醒。
    failSandboxBackgroundEvalsForSession(this.background, sessionId);
  }

  /** 全部实例释放（runtime close / 进程退出走这里；与 disposeNodeReplSession 同级）。 */
  disposeAll(): void {
    for (const sessionId of this.entries.keys()) this.dispose(sessionId);
  }

  /** 控制台执行行列表（控制台 tab 的展示行；实例死亡即空，随实例消失）。 */
  readExecutions(sessionId: SessionId): SandboxExecutionRow[] {
    return [...(this.entries.get(sessionId)?.executions ?? [])];
  }

  /** 控制台只读快照：存在性 + 执行行 + console 全环（tab 轮询读这一个）。 */
  readConsoleSnapshot(sessionId: SessionId): {
    alive: boolean;
    executions: SandboxExecutionRow[];
    lines: import("@zcode/contracts").SandboxConsoleLine[];
    truncated: boolean;
  } {
    const entry = this.entries.get(sessionId);
    if (!entry) return { alive: false, executions: [], lines: [], truncated: false };
    const window = entry.instance.readConsoleWindow({});
    return {
      alive: true,
      executions: [...entry.executions],
      lines: window.lines,
      truncated: window.truncated,
    };
  }

  heapBytes(sessionId: SessionId): number | undefined {
    return this.entries.get(sessionId)?.instance.heapBytes();
  }

  hasLiveInstance(sessionId: SessionId): boolean {
    return this.entries.has(sessionId);
  }

  /** 测试与单测用：当前活实例数。 */
  liveCount(): number {
    return this.entries.size;
  }

  private async getOrCreate(sessionId: SessionId, signal?: AbortSignal): Promise<TableEntry> {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const inflight = this.creating.get(sessionId);
    if (inflight) {
      const instance = await inflight;
      const entry = this.entries.get(sessionId);
      if (entry) return entry;
      const fresh: TableEntry = { instance, fresh: true, executions: [] };
      this.entries.set(sessionId, fresh);
      return fresh;
    }
    const pending = this.createInstance(sessionId, signal);
    this.creating.set(sessionId, pending);
    try {
      const instance = await pending;
      const fresh: TableEntry = { instance, fresh: true, executions: [] };
      this.entries.set(sessionId, fresh);
      return fresh;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  private async createInstance(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SandboxInstance> {
    const { loadSandboxLocalStorageSnapshot } = await import("./local-storage-store.js");
    const snapshot = await loadSandboxLocalStorageSnapshot({
      cliStorageRoot: this.deps.cliStorageRoot,
      fileSystemPort: this.deps.fileSystemPort,
      sessionId,
      signal,
    });
    const sessionIdForHost = sessionId;
    const [fsHost, fetchHost, sqliteHost] = buildSandboxInstanceHosts(sessionIdForHost, {
      fileSystemPort: this.deps.fileSystemPort,
      sqliteReadPort: this.deps.sqliteReadPort,
      resolveFsHost: this.deps.resolveFsHost,
      resolveFetchHost: this.deps.resolveFetchHost,
      resolveSqliteHost: this.deps.resolveSqliteHost,
    });
    return SandboxInstance.create(snapshot, fsHost, fetchHost, sqliteHost);
  }
}

/** LocalStorage 文件路径的测试/存储扫描导出（阶段6的 catalog 前缀按此聚合）。 */
export function sandboxLocalStoragePathForSession(input: {
  cliStorageRoot: string;
  sessionId: string;
}): string {
  return resolveSandboxLocalStoragePath(input);
}
