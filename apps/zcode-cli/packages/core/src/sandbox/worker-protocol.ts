// ============================================================
// 沙盒 Worker 消息协议（主线程 ↔ 常驻 QuickJS Worker）
// ============================================================
// 每条跨线程消息都带 {workerId, generation, sessionId}：
// 主线程只接受当前实例 identity 的消息，陈旧结果直接丢弃，
// 绝不写入新实例投影或结算新请求。
//
// 主线程永不执行 guest JS、永不 Atomics.wait、永不直接 node:fs；
// Worker 内持有 VM / global / 定时器 / LocalStorage 活态。
// 宿主调用（fs/fetch/sqlite）由 Worker 发 host-call，主线程按 sessionId
// 现读端口执行后按 requestId 恰好结算一次。
//
// 同步桥：host-call 可携带 SharedArrayBuffer 信号，Worker 侧 Atomics.wait、
// 主线程侧写结果后 Atomics.notify（见 sync-bridge.ts）。

import type { FileSystemNodeKind } from "@zcode/contracts";
import type { HostArg, SandboxHostErrorInfo } from "./host-args.js";

export interface SandboxWorkerIdentity {
  workerId: string;
  generation: number;
  sessionId: string;
}

export interface SandboxWorkerInitData extends SandboxWorkerIdentity {
  /** quickjs.wasm 绝对路径（由主线程解析，Worker 不依赖 import.meta.url）。 */
  wasmPath: string;
  /** 磁盘灌回的最后有序快照；缺席即空世界。 */
  localStorageSnapshot?: Record<string, string>;
}

/** guest 安装器依赖的最小宿主调用面（Worker 内由 bridge 实现）。 */
export interface SandboxHostCaller {
  call(
    op: SandboxHostOperation,
    args: HostArg[],
    options?: { signalId?: number },
  ): Promise<unknown>;
  /**
   * 同步宿主调用：Worker 发送 host-call 后阻塞在 SAB 上，主线程执行端口
   * 并唤醒。只允许 Worker 侧实现，主线程永不这样调用。
   */
  callSync(op: SandboxHostOperation, args: HostArg[]): unknown;
  /** guest AbortController.abort()：取消该 signalId 名下所有在飞请求。 */
  abortSignal?(signalId: number): void;
}

export type SandboxHostOperation =
  | "fs.readFile"
  | "fs.writeFile"
  | "fs.appendFile"
  | "fs.readdir"
  | "fs.stat"
  | "fs.lstat"
  | "fs.access"
  | "fs.mkdir"
  | "fs.unlink"
  | "fs.rmdir"
  | "fs.rm"
  | "fs.rename"
  | "fs.copyFile"
  | "fs.realpath"
  | "fetch"
  | "sqlite.query"
  | "sqlite.tables";

/** 同步桥信号：Worker 侧等待，主线程写完后 notify。 */
export interface SandboxSyncHostCallSignal {
  buffer: SharedArrayBuffer;
}

export interface SandboxFsReadFileResult {
  kind: "string" | "bytes";
  value: string | Uint8Array;
}

export interface SandboxFsReaddirResult {
  entries: Array<{ name: string; kind: FileSystemNodeKind }>;
}

export interface SandboxFsStatResult {
  kind: FileSystemNodeKind;
  sizeBytes: number;
  mtimeMs: number;
}

export interface SandboxFetchResult {
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SandboxSqliteQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface SandboxSqliteTablesResult {
  tables: string[];
}

export interface SandboxEvalRequestMessage extends SandboxWorkerIdentity {
  type: "eval";
  requestId: number;
  code: string;
  mode: "model" | "user";
}

export interface SandboxHostResultMessage extends SandboxWorkerIdentity {
  type: "host-result";
  requestId: number;
  ok: boolean;
  value?: unknown;
  error?: SandboxHostErrorInfo;
  /** 同步桥直接写 SAB，不经消息回传结果。 */
  sync?: SandboxSyncHostCallSignal;
}

export interface SandboxHostAbortMessage extends SandboxWorkerIdentity {
  type: "host-abort";
  requestId: number;
}

export type SandboxWorkerInboundMessage =
  | SandboxEvalRequestMessage
  | SandboxHostResultMessage
  | SandboxHostAbortMessage;

export interface SandboxWorkerReadyMessage extends SandboxWorkerIdentity {
  type: "ready";
}

export interface SandboxWorkerConsoleMessage extends SandboxWorkerIdentity {
  type: "console";
  method: string;
  text: string;
}

export type SandboxLocalStorageOperation =
  | { op: "set"; key: string; value: string }
  | { op: "remove"; key: string }
  | { op: "clear" };

export interface SandboxWorkerLocalStorageMessage extends SandboxWorkerIdentity {
  type: "local-storage";
  change: SandboxLocalStorageOperation;
}

export interface SandboxWorkerEvalResultMessage extends SandboxWorkerIdentity {
  type: "eval-result";
  requestId: number;
  /** false = host 回调抛错导致 VM 已坏，调用方重建。 */
  alive: boolean;
  ok: boolean;
  returnText?: string;
  error?: { code: string; message: string };
  heapBytes?: number;
}

export interface SandboxWorkerHostCallMessage extends SandboxWorkerIdentity {
  type: "host-call";
  requestId: number;
  op: SandboxHostOperation;
  args: HostArg[];
  /** 同步调用携带等待信号；异步调用恒缺席。 */
  sync?: SandboxSyncHostCallSignal;
}

export interface SandboxWorkerHostAbortMessage extends SandboxWorkerIdentity {
  type: "host-abort";
  requestId: number;
}

export interface SandboxWorkerFatalMessage extends SandboxWorkerIdentity {
  type: "fatal";
  error: SandboxHostErrorInfo;
}

export type SandboxWorkerOutboundMessage =
  | SandboxWorkerReadyMessage
  | SandboxWorkerConsoleMessage
  | SandboxWorkerLocalStorageMessage
  | SandboxWorkerEvalResultMessage
  | SandboxWorkerHostCallMessage
  | SandboxWorkerHostAbortMessage
  | SandboxWorkerFatalMessage;

export function matchesSandboxWorkerIdentity(
  message: unknown,
  identity: SandboxWorkerIdentity,
): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as Partial<SandboxWorkerIdentity>;
  return record.workerId === identity.workerId && record.generation === identity.generation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Worker 出口校验：主线程只处理形状正确的消息。 */
export function isSandboxWorkerOutboundMessage(
  message: unknown,
): message is SandboxWorkerOutboundMessage {
  if (!isRecord(message)) return false;
  if (typeof message.workerId !== "string") return false;
  if (typeof message.generation !== "number") return false;
  if (typeof message.sessionId !== "string") return false;
  switch (message.type) {
    case "ready":
    case "fatal":
      return true;
    case "console":
      return typeof message.method === "string" && typeof message.text === "string";
    case "local-storage":
      return isRecord(message.change) && typeof message.change.op === "string";
    case "eval-result":
      return typeof message.requestId === "number" && typeof message.alive === "boolean";
    case "host-call":
      return (
        typeof message.requestId === "number" &&
        typeof message.op === "string" &&
        Array.isArray(message.args) &&
        (message.sync === undefined ||
          (isRecord(message.sync) && message.sync.buffer instanceof SharedArrayBuffer))
      );
    case "host-abort":
      return typeof message.requestId === "number";
    default:
      return false;
  }
}

/** Worker 入口校验：主线程消息同样必须带 identity。 */
export function isSandboxWorkerInboundMessage(
  message: unknown,
): message is SandboxWorkerInboundMessage {
  if (!isRecord(message)) return false;
  if (typeof message.workerId !== "string") return false;
  if (typeof message.generation !== "number") return false;
  if (typeof message.sessionId !== "string") return false;
  if (message.type === "eval") {
    return (
      typeof message.requestId === "number" &&
      typeof message.code === "string" &&
      (message.mode === "model" || message.mode === "user")
    );
  }
  if (message.type === "host-result") return typeof message.requestId === "number";
  if (message.type === "host-abort") return typeof message.requestId === "number";
  return false;
}
