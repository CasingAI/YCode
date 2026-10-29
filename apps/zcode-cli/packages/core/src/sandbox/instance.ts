/* eslint-disable max-lines -- 生命周期、generation、请求结算与三类宿主调用共用同一份实例状态，拆文件会让边界分散。 */
// ============================================================
// Sandbox 实例：常驻 QuickJS Worker 的主线程代理
// ============================================================
// 一份实例 = 一个 worker_threads Worker（内含唯一 QuickJS VM）。
// 主线程不再创建 VM、不再执行 guest JS，只持有：
//   - console 环 / heap / LocalStorage 的有界镜像（唯一权威在 Worker，按序事件更新）
//   - pending eval 表与 requestId
//   - 宿主端口分发器（Worker 的 fs/fetch/sqlite 请求在这里落到异步端口）
//
// 销毁 = worker.terminate() 并立即丢弃引用，不等待 Worker 回消息；CPU 死循环
// 下 terminate 仍能完成。所有回包都校验 workerId + generation，陈旧消息直接丢弃。
//
// 作用域隔离：源码在 Worker 内用函数作用域包一层再 eval，只有赋给全局的值
// 跨调用可见（符合 spec「不挂全局不保存」）。`return` 在包装函数内合法。

import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { SandboxConsoleLine, SandboxEvalResult, SessionId } from "@zcode/contracts";
import { SandboxConsoleRing } from "./console-ring.js";
import type { SandboxFetchHostLookup, SandboxInstanceFetchHost } from "./fetch-host-context.js";
import type { SandboxFsHostLookup, SandboxInstanceFsHost } from "./fs-host-context.js";
import { SandboxHostDispatcher, type SandboxHostCallOutcome } from "./host-dispatch.js";
import { SANDBOX_FS_STALE_GENERATION } from "./fs-errors.js";
import { SandboxLocalStorage, type SandboxLocalStorageSnapshot } from "./local-storage.js";
import type { SandboxInstanceSqliteHost, SandboxSqliteHostLookup } from "./sqlite-host-context.js";
import { resolveSandboxSyncHostCall } from "./sync-bridge.js";
import { resolveSandboxWorkerAssets } from "./worker-assets.js";
import {
  isSandboxWorkerOutboundMessage,
  matchesSandboxWorkerIdentity,
  type SandboxWorkerIdentity,
  type SandboxWorkerInitData,
  type SandboxWorkerInboundMessage,
  type SandboxWorkerOutboundMessage,
} from "./worker-protocol.js";

export interface SandboxInstanceEvalOutcome {
  result: SandboxEvalResult;
  /** 本次 eval 后实例是否仍可用（false = VM 已坏 / Worker 已退出，调用方重建）。 */
  alive: boolean;
}

/** Worker 的最小可注入面（测试可替换；生产用 node:worker_threads）。 */
export interface SandboxWorkerPort {
  postMessage(value: unknown): void;
  terminate(): Promise<number> | number | void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  unref?(): void;
}

export type SandboxWorkerFactory = (
  workerUrl: URL,
  init: SandboxWorkerInitData,
) => SandboxWorkerPort;

export interface SandboxInstanceWorkerOptions {
  /** 由实例表分配的会话内 generation（默认 1）。 */
  generation?: number;
  /** 显式 workerId（默认随机 UUID）。 */
  workerId?: string;
  /** 显式 sessionId（默认从 host contexts 推断）。 */
  sessionId?: SessionId;
  /** 测试注入：worker 入口与 wasm 路径。 */
  workerUrl?: URL;
  wasmPath?: string;
  /** 测试注入：自定义 Worker 工厂。 */
  workerFactory?: SandboxWorkerFactory;
  /** LocalStorage 镜像每次有序变更后回调（实例表用于落盘）。 */
  onLocalStorageChange?: () => void;
}

interface PendingEval {
  fromSeq: number;
  resolve(outcome: SandboxInstanceEvalOutcome): void;
}

const noFsLookup: SandboxFsHostLookup = () => undefined;
const noFetchLookup: SandboxFetchHostLookup = () => undefined;
const noSqliteLookup: SandboxSqliteHostLookup = () => undefined;

export class SandboxInstance {
  readonly consoleRing = new SandboxConsoleRing();
  readonly localStorage: SandboxLocalStorage;
  readonly workerId: string;
  readonly generation: number;
  private readonly identity: SandboxWorkerIdentity;
  private readonly worker: SandboxWorkerPort;
  private readonly dispatcher: SandboxHostDispatcher;
  private readonly onLocalStorageChange?: () => void;
  private readonly pending = new Map<number, PendingEval>();
  private nextRequestId = 1;
  private disposed = false;
  private workerDead = false;
  private heapMirror: number | undefined;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;

  private constructor(
    worker: SandboxWorkerPort,
    identity: SandboxWorkerIdentity,
    localStorageSnapshot: SandboxLocalStorageSnapshot | undefined,
    fsLookup: SandboxFsHostLookup,
    fetchLookup: SandboxFetchHostLookup,
    sqliteLookup: SandboxSqliteHostLookup,
    options: SandboxInstanceWorkerOptions,
  ) {
    this.worker = worker;
    this.identity = identity;
    this.workerId = identity.workerId;
    this.generation = identity.generation;
    this.localStorage = new SandboxLocalStorage(localStorageSnapshot);
    this.onLocalStorageChange = options.onLocalStorageChange;
    this.dispatcher = new SandboxHostDispatcher({
      fs: fsLookup,
      fetch: fetchLookup,
      sqlite: sqliteLookup,
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // ready 失败在 create() 里被 await；避免无人消费时成为未处理拒绝。
    this.ready.catch(() => undefined);
    this.attachWorker();
  }

  static async create(
    localStorageSnapshot?: SandboxLocalStorageSnapshot,
    fsHost?: SandboxInstanceFsHost,
    fetchHost?: SandboxInstanceFetchHost,
    sqliteHost?: SandboxInstanceSqliteHost,
    options: SandboxInstanceWorkerOptions = {},
  ): Promise<SandboxInstance> {
    const assets = resolveSandboxWorkerAssets({
      workerUrl: options.workerUrl,
      wasmPath: options.wasmPath,
    });
    const sessionId =
      options.sessionId ??
      fsHost?.sessionId ??
      fetchHost?.sessionId ??
      sqliteHost?.sessionId ??
      ("" as SessionId);
    const identity: SandboxWorkerIdentity = {
      workerId: options.workerId ?? randomUUID(),
      generation: options.generation ?? 1,
      sessionId: String(sessionId),
    };
    const init: SandboxWorkerInitData = {
      ...identity,
      wasmPath: assets.wasmPath,
      ...(localStorageSnapshot === undefined ? {} : { localStorageSnapshot }),
    };
    const worker = (options.workerFactory ?? defaultSandboxWorkerFactory)(assets.workerUrl, init);
    const instance = new SandboxInstance(
      worker,
      identity,
      localStorageSnapshot,
      fsHost?.resolve ?? noFsLookup,
      fetchHost?.resolve ?? noFetchLookup,
      sqliteHost?.resolve ?? noSqliteLookup,
      options,
    );
    await instance.ready;
    return instance;
  }

  /** 堆占用字节（Worker 上报的镜像；Worker 已死时保留最后一次已知值）。 */
  heapBytes(): number | undefined {
    return this.heapMirror;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  async eval(code: string): Promise<SandboxInstanceEvalOutcome> {
    return this.runEval(code, "model");
  }

  /**
   * 控制台用户 eval（DevTools 语义）：表达式优先、SyntaxError 才回退语句。
   * 回退发生在 Worker 内（有 VM 与 rewrite），主线程只拿最终 outcome。
   */
  async evalUser(code: string): Promise<SandboxInstanceEvalOutcome> {
    return this.runEval(code, "user");
  }

  /** 读 console 窗口（后台 TaskOutput 与控制台投影共用，读主线程镜像）。 */
  readConsoleWindow(input: { filter?: string; fromSeq?: number; limit?: number } = {}): {
    lines: SandboxConsoleLine[];
    truncated: boolean;
  } {
    return this.consoleRing.window(input);
  }

  /** 立即销毁：terminate Worker，不等待其响应；在途 eval 按失败结算。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dispatcher.dispose();
    this.settleAllPending({
      kind: "failed",
      error: { code: "sandbox_disposed", message: "沙盒实例已销毁" },
      consoleLines: [],
      consoleTruncated: false,
    });
    try {
      // 不等待 Worker 响应：CPU 死循环下也能立即完成；terminate 失败视为已退出。
      void Promise.resolve(this.worker.terminate()).catch(() => undefined);
    } catch {
      // 已退出/已终止：幂等。
    }
  }

  private async runEval(code: string, mode: "model" | "user"): Promise<SandboxInstanceEvalOutcome> {
    if (this.disposed || this.workerDead) {
      return {
        alive: false,
        result: {
          kind: "failed",
          error: { code: "sandbox_disposed", message: "沙盒实例已销毁" },
          consoleLines: [],
          consoleTruncated: false,
        },
      };
    }
    const requestId = this.nextRequestId++;
    const fromSeq = this.consoleRing.watermark();
    return new Promise<SandboxInstanceEvalOutcome>((resolve) => {
      this.pending.set(requestId, { fromSeq, resolve });
      try {
        this.post({ ...this.identity, type: "eval", requestId, code, mode });
      } catch (error) {
        this.pending.delete(requestId);
        this.workerDead = true;
        resolve(this.failedOutcome(error, fromSeq));
      }
    });
  }

  private attachWorker(): void {
    this.worker.on("message", (message: unknown) => this.handleMessage(message));
    this.worker.on("error", (error: Error) => {
      if (this.disposed) return;
      this.workerDead = true;
      this.readyReject(error);
      this.settleAllPending({
        kind: "failed",
        error: { code: "sandbox_worker_error", message: error.message || String(error) },
        consoleLines: [],
        consoleTruncated: false,
      });
    });
    this.worker.on("exit", (code: number) => {
      if (this.disposed) return;
      this.workerDead = true;
      this.readyReject(new Error(`Sandbox worker exited unexpectedly (code ${code})`));
      this.settleAllPending({
        kind: "failed",
        error: {
          code: "sandbox_worker_exited",
          message: `Sandbox worker exited unexpectedly (code ${code})`,
        },
        consoleLines: [],
        consoleTruncated: false,
      });
    });
    // 不 unref：Worker 常驻并持有 VM/定时器，必须在实例表 dispose 时显式
    // terminate；否则提前 unref 会在 create 等待 ready 期间让事件循环空转退出。
  }

  private handleMessage(message: unknown): void {
    if (!isSandboxWorkerOutboundMessage(message)) return;
    const identityMatches =
      matchesSandboxWorkerIdentity(message, this.identity) &&
      message.sessionId === this.identity.sessionId;
    if (!identityMatches) {
      // 陈旧 generation 的同步请求也必须结算，否则旧 Worker 会永久阻塞。
      if (message.type === "host-call" && message.sync) {
        resolveSandboxSyncHostCall(message.sync, {
          ok: false,
          error: {
            code: SANDBOX_FS_STALE_GENERATION,
            message:
              "Sandbox sync filesystem request came from a stale worker generation and was rejected.",
            name: "Error",
          },
        });
      }
      return;
    }
    if (this.disposed) {
      if (message.type === "host-call" && message.sync) {
        resolveSandboxSyncHostCall(message.sync, {
          ok: false,
          error: { code: "sandbox_disposed", message: "沙盒实例已销毁", name: "Error" },
        });
      }
      return;
    }
    switch (message.type) {
      case "ready":
        this.readyResolve();
        return;
      case "fatal":
        this.workerDead = true;
        this.readyReject(
          new Error(
            `Sandbox worker failed to start: ${message.error.code} ${message.error.message}`,
          ),
        );
        this.settleAllPending({
          kind: "failed",
          error: message.error,
          consoleLines: [],
          consoleTruncated: false,
        });
        return;
      case "console":
        this.consoleRing.push(message.method, message.text);
        return;
      case "local-storage":
        this.applyLocalStorageChange(message.change);
        return;
      case "eval-result":
        this.settleEval(message);
        return;
      case "host-call":
        this.dispatchHostCall(message);
        return;
      case "host-abort":
        this.dispatcher.abort(message.requestId);
        return;
    }
  }

  private settleEval(
    message: Extract<SandboxWorkerOutboundMessage, { type: "eval-result" }>,
  ): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (typeof message.heapBytes === "number") this.heapMirror = message.heapBytes;
    const window = this.consoleRing.evalWindow({ fromSeq: pending.fromSeq });
    if (message.ok) {
      pending.resolve({
        alive: message.alive,
        result: {
          kind: "completed",
          ...(message.returnText === undefined ? {} : { returnText: message.returnText }),
          ...window,
        },
      });
      return;
    }
    pending.resolve({
      alive: message.alive,
      result: {
        kind: "failed",
        error: message.error ?? { code: "Error", message: "沙盒执行失败" },
        ...window,
      },
    });
  }

  private dispatchHostCall(
    message: Extract<SandboxWorkerOutboundMessage, { type: "host-call" }>,
  ): void {
    const requestId = message.requestId;
    const sync = message.sync;
    void this.dispatcher.call(requestId, message.op, message.args, Boolean(sync)).then(
      (outcome) => {
        if (sync) {
          // 同步桥直接写 SAB 并唤醒 Worker；即使实例已销毁也要结算。
          resolveSandboxSyncHostCall(sync, toSyncHostCallResult(message.op, outcome));
          return;
        }
        if (this.disposed) return;
        const reply: SandboxWorkerInboundMessage = outcome.ok
          ? { ...this.identity, type: "host-result", requestId, ok: true, value: outcome.value }
          : { ...this.identity, type: "host-result", requestId, ok: false, error: outcome.error };
        try {
          this.post(reply);
        } catch {
          // Worker 已退出：在飞请求由 Worker bridge dispose 结算，不悬挂。
        }
      },
      (error: unknown) => {
        // dispatcher 内部已归一错误；这里兜底，保证同步请求恰好结算一次。
        const info =
          error instanceof Error
            ? { code: "EIO", message: error.message, name: error.name || "Error" }
            : { code: "EIO", message: String(error), name: "Error" };
        if (sync) {
          resolveSandboxSyncHostCall(sync, { ok: false, error: info });
          return;
        }
      },
    );
  }

  private applyLocalStorageChange(change: {
    op: "set" | "remove" | "clear";
    key?: string;
    value?: string;
  }): void {
    try {
      switch (change.op) {
        case "set":
          this.localStorage.setItem(change.key ?? "", change.value ?? "");
          break;
        case "remove":
          this.localStorage.removeItem(change.key ?? "");
          break;
        case "clear":
          this.localStorage.clear();
          break;
      }
    } catch {
      // 镜像与 Worker 同源、同配额；此处异常不改变 Worker 的权威结果。
    }
    try {
      this.onLocalStorageChange?.();
    } catch {
      // 落盘回调失败非致命，后续调用可再次保存。
    }
  }

  private settleAllPending(result: SandboxEvalResult): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.resolve({ alive: false, result });
  }

  private failedOutcome(error: unknown, fromSeq: number): SandboxInstanceEvalOutcome {
    return {
      alive: false,
      result: {
        kind: "failed",
        error: {
          code: error instanceof Error && error.name ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
        ...this.consoleRing.evalWindow({ fromSeq }),
      },
    };
  }

  private post(message: SandboxWorkerInboundMessage): void {
    this.worker.postMessage(message);
  }
}

/**
 * 同步桥的结果形态：readFile 的 {kind,value} 包装在 Worker 侧无用，
 * 直接交回 string / Uint8Array，由 sync-bridge 走文本 / 二进制分帧。
 * 其余操作保持 JSON 可序列化的原值。
 */
function toSyncHostCallResult(
  op: Extract<SandboxWorkerOutboundMessage, { type: "host-call" }>["op"],
  outcome: SandboxHostCallOutcome,
): SandboxHostCallOutcome {
  if (!outcome.ok || op !== "fs.readFile") return outcome;
  const payload = outcome.value as { kind?: unknown; value?: unknown } | undefined;
  if (
    payload &&
    typeof payload === "object" &&
    (payload.kind === "bytes" || payload.kind === "string")
  ) {
    return { ok: true, value: payload.value };
  }
  return outcome;
}

function defaultSandboxWorkerFactory(
  workerUrl: URL,
  init: SandboxWorkerInitData,
): SandboxWorkerPort {
  return new Worker(workerUrl, {
    workerData: init,
    name: `zcode-sandbox-${init.sessionId || "session"}-${init.generation}`,
  }) as unknown as SandboxWorkerPort;
}
