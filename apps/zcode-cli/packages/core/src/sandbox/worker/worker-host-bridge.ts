// ============================================================
// Worker 侧宿主调用桥
// ============================================================
// guest 的 fs/fetch/sqlite 安装器经这里发 host-call；主线程执行端口后按
// requestId 回 host-result。每个请求恰好结算一次：超时、abort、Worker
// 销毁都走 settle 守卫，迟到回包直接丢弃。

import type { SandboxHostErrorInfo, HostArg } from "../host-args.js";
import { SandboxHostError, sandboxHostErrorInfo } from "../host-args.js";
import {
  createSandboxSyncHostCallSignal,
  sandboxSyncCapacityForOperation,
  SANDBOX_SYNC_HOST_CALL_TIMEOUT_MS,
} from "../sync-bridge.js";
import type {
  SandboxHostOperation,
  SandboxHostResultMessage,
  SandboxHostAbortMessage,
  SandboxWorkerHostCallMessage,
  SandboxWorkerIdentity,
} from "../worker-protocol.js";

export interface SandboxHostCallOptions {
  /** guest AbortController 的内部 id；abort 时由 Worker 取消对应在飞请求。 */
  signalId?: number;
}

interface PendingHostCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  signalId?: number;
}

export interface SandboxHostBridgePoster {
  postMessage(message: SandboxWorkerHostCallMessage | SandboxHostAbortMessage): void;
}

export class SandboxWorkerHostBridge {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingHostCall>();
  private readonly signalIndex = new Map<number, Set<number>>();
  private disposed = false;

  constructor(
    private readonly poster: SandboxHostBridgePoster,
    private readonly identity: SandboxWorkerIdentity,
  ) {}

  call(
    op: SandboxHostOperation,
    args: HostArg[],
    options: SandboxHostCallOptions = {},
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new SandboxHostError("sandbox_disposed", "沙盒实例已销毁"));
    }
    const requestId = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        settled: false,
        ...(options.signalId !== undefined ? { signalId: options.signalId } : {}),
      });
      if (options.signalId !== undefined) {
        let requests = this.signalIndex.get(options.signalId);
        if (!requests) {
          requests = new Set();
          this.signalIndex.set(options.signalId, requests);
        }
        requests.add(requestId);
      }
      try {
        this.poster.postMessage({
          ...this.identity,
          type: "host-call",
          requestId,
          op,
          args,
        });
      } catch (error) {
        this.reject(requestId, sandboxHostErrorInfo(error));
      }
    });
  }

  /**
   * 同步宿主调用：发送 host-call 后阻塞在独立 SharedArrayBuffer 上，
   * 主线程执行完现有异步端口后写入结果并 Atomics.notify。
   * 只阻塞本 Worker；超时按桥失败抛出，不永久挂起。
   */
  callSync(op: SandboxHostOperation, args: HostArg[]): unknown {
    if (this.disposed) {
      throw new SandboxHostError("sandbox_disposed", "沙盒实例已销毁");
    }
    const waiter = createSandboxSyncHostCallSignal(sandboxSyncCapacityForOperation(op));
    const requestId = this.nextRequestId++;
    try {
      this.poster.postMessage({
        ...this.identity,
        type: "host-call",
        requestId,
        op,
        args,
        sync: { buffer: waiter.buffer },
      });
    } catch (error) {
      const info = sandboxHostErrorInfo(error);
      throw new SandboxHostError(info.code, info.message, info.name);
    }
    const result = waiter.wait(SANDBOX_SYNC_HOST_CALL_TIMEOUT_MS);
    if (!result.ok) {
      const error = result.error ?? {
        code: "SANDBOX_FS_SYNC_BRIDGE",
        message: "Sandbox sync host call failed",
        name: "Error",
      };
      throw toHostError(error);
    }
    return result.value;
  }

  handleResult(message: SandboxHostResultMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.settled) return;
    if (message.ok) {
      this.settle(message.requestId, () => pending.resolve(message.value));
      return;
    }
    const error = message.error ?? {
      code: "sandbox_host_call_failed",
      message: "Sandbox host call failed",
      name: "Error",
    };
    this.settle(message.requestId, () => pending.reject(toHostError(error)));
  }

  /** 主线程主动取消某请求（实例销毁 / 端口缺失）：本地按 abort 结算一次。 */
  handleAbort(requestId: number): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.settled) return;
    this.settle(requestId, () =>
      pending.reject(new SandboxHostError("ABORT_ERR", "The operation was aborted", "AbortError")),
    );
  }

  /** guest AbortController.abort()：先本地拒绝，再通知主线程取消端口调用。 */
  abortSignal(signalId: number): void {
    const requests = this.signalIndex.get(signalId);
    if (!requests) return;
    this.signalIndex.delete(signalId);
    for (const requestId of requests) {
      const pending = this.pending.get(requestId);
      if (!pending || pending.settled) continue;
      try {
        this.poster.postMessage({
          ...this.identity,
          type: "host-abort",
          requestId,
        });
      } catch {
        // Worker 已销毁：本地结算仍然生效。
      }
      this.settle(requestId, () =>
        pending.reject(
          new SandboxHostError("ABORT_ERR", "The operation was aborted", "AbortError"),
        ),
      );
    }
  }

  /** Worker 销毁：所有在飞请求按失败结算，绝不悬挂。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [requestId, pending] of this.pending) {
      if (pending.settled) continue;
      this.settle(requestId, () =>
        pending.reject(new SandboxHostError("sandbox_disposed", "沙盒实例已销毁")),
      );
    }
    this.signalIndex.clear();
  }

  private reject(requestId: number, error: SandboxHostErrorInfo): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.settled) return;
    this.settle(requestId, () => pending.reject(toHostError(error)));
  }

  private settle(requestId: number, run: () => void): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pending.delete(requestId);
    if (pending.signalId !== undefined) {
      const requests = this.signalIndex.get(pending.signalId);
      requests?.delete(requestId);
      if (requests && requests.size === 0) this.signalIndex.delete(pending.signalId);
    }
    try {
      run();
    } catch {
      // guest 侧已销毁：结算作废。
    }
  }
}

function toHostError(info: SandboxHostErrorInfo): SandboxHostError {
  return new SandboxHostError(info.code, info.message, info.name);
}
