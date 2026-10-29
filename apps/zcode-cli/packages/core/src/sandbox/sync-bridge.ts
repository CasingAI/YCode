// ============================================================
// 同步宿主调用桥原语（阶段2：Worker 阻塞，主线程异步执行）
// ============================================================
// Worker 不能通过消息获得同步返回值：消息是异步的。同步 FS 的流程是：
//   Worker 发 host-call（携带独立 SAB）→ 阻塞在 Atomics.wait
//   主线程照常走异步端口 → 把结果写进 SAB 并 Atomics.notify
//   Worker 被唤醒后同步读取并返给 guest
//
// 只阻塞该会话的 Worker；主线程永不 Atomics.wait。
//
// 布局（前 16 字节为 Int32 头）：
//   [0] state：0=等待，1=成功，2=失败
//   [1] totalBytes：payload 区实际使用字节数（meta + raw）
//   [2] metaBytes：payload 区开头 JSON 元数据长度
//   [3] resolved：主线程是否已结算（1 = 已 notify，重复结算直接忽略）
//   [16..] payload：JSON 元数据 + 可选原始字节（读文件正文 / UTF-8 文本）
//
// 二进制结果不走 JSON（Uint8Array JSON 化会失真且 base64 会膨胀），
// 元数据只描述 valueType / bytesLength，紧跟在元数据后写原始字节。
//
// 每个请求由 Worker 创建独立 SAB；主线程对同一 SAB 只 notify 一次，
// 成功、端口缺失、只读拒绝、超限、序列化失败、陈旧 generation、Worker
// 终止都必须写回错误并唤醒，不能留下永久等待。

import { SANDBOX_FS_READ_MAX_BYTES } from "./constants.js";
import type { SandboxHostErrorInfo } from "./host-args.js";
import type { SandboxHostOperation, SandboxSyncHostCallSignal } from "./worker-protocol.js";

export const SANDBOX_SYNC_SIGNAL_HEADER_BYTES = 16;
export const SANDBOX_SYNC_SIGNAL_STATE_PENDING = 0;
export const SANDBOX_SYNC_SIGNAL_STATE_OK = 1;
export const SANDBOX_SYNC_SIGNAL_STATE_ERROR = 2;

/** 元数据 / 路径 / Stats 等小型结果的保留区。 */
const SANDBOX_SYNC_METADATA_CAPACITY_BYTES = 64 * 1024;
/** readdir 结果上限：有界 JSON，超限失败不截断。 */
const SANDBOX_SYNC_LISTING_CAPACITY_BYTES = 4 * 1024 * 1024;
/** 默认容量（未知操作）：只放元数据即可。 */
export const SANDBOX_SYNC_SIGNAL_DEFAULT_CAPACITY_BYTES = SANDBOX_SYNC_METADATA_CAPACITY_BYTES;

/** 等待上限：主线程若因异常没有回包，到点按桥失败结算，绝不永久挂起。 */
export const SANDBOX_SYNC_HOST_CALL_TIMEOUT_MS = 30_000;

/**
 * 按操作分配共享缓冲容量。容量在 Worker 发起请求时确定：
 * 读文件沿用 16MiB 上限并留元数据余量；列表有界；其它只留元数据。
 */
export function sandboxSyncCapacityForOperation(op: SandboxHostOperation): number {
  switch (op) {
    case "fs.readFile":
      return SANDBOX_FS_READ_MAX_BYTES + SANDBOX_SYNC_METADATA_CAPACITY_BYTES;
    case "fs.readdir":
      return SANDBOX_SYNC_LISTING_CAPACITY_BYTES;
    default:
      return SANDBOX_SYNC_METADATA_CAPACITY_BYTES;
  }
}

export interface SandboxSyncHostCallResult {
  ok: boolean;
  value?: unknown;
  error?: SandboxHostErrorInfo;
}

export interface SandboxSyncHostCallWaiter extends SandboxSyncHostCallSignal {
  wait(timeoutMs?: number): SandboxSyncHostCallResult;
}

export function createSandboxSyncHostCallSignal(
  capacityBytes = SANDBOX_SYNC_SIGNAL_DEFAULT_CAPACITY_BYTES,
): SandboxSyncHostCallWaiter {
  if (capacityBytes <= 0) throw new Error("Sandbox sync signal capacity must be positive");
  const buffer = new SharedArrayBuffer(SANDBOX_SYNC_SIGNAL_HEADER_BYTES + capacityBytes);
  const header = new Int32Array(buffer, 0, 4);
  const payload = new Uint8Array(buffer, SANDBOX_SYNC_SIGNAL_HEADER_BYTES);
  return {
    buffer,
    wait(timeoutMs = SANDBOX_SYNC_HOST_CALL_TIMEOUT_MS) {
      const state = Atomics.wait(header, 0, SANDBOX_SYNC_SIGNAL_STATE_PENDING, timeoutMs);
      if (state === "timed-out") {
        return {
          ok: false,
          error: {
            code: "SANDBOX_FS_SYNC_BRIDGE",
            message: `Sandbox sync host call timed out after ${timeoutMs}ms`,
            name: "Error",
          },
        };
      }
      const totalBytes = Atomics.load(header, 1);
      const metaBytes = Atomics.load(header, 2);
      if (metaBytes < 0 || totalBytes < metaBytes || totalBytes > payload.byteLength) {
        return bridgeError("Sandbox sync host call returned an invalid payload length");
      }
      try {
        const meta = JSON.parse(
          new TextDecoder("utf8").decode(payload.subarray(0, metaBytes)),
        ) as SandboxSyncPayloadMeta;
        if (!meta || meta.ok !== true) {
          return {
            ok: false,
            error: meta?.error ?? bridgeErrorInfo("Sandbox sync host call failed"),
          };
        }
        const raw = payload.subarray(metaBytes, totalBytes);
        if (meta.valueType === "bytes") {
          return { ok: true, value: raw.slice() };
        }
        if (meta.valueType === "text") {
          return { ok: true, value: new TextDecoder("utf8").decode(raw) };
        }
        return { ok: true, value: meta.value };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "SANDBOX_FS_SYNC_BRIDGE",
            message: error instanceof Error ? error.message : String(error),
            name: "Error",
          },
        };
      }
    },
  };
}

interface SandboxSyncPayloadMeta {
  ok: boolean;
  valueType?: "json" | "bytes" | "text";
  value?: unknown;
  /**
   * `bytes` / `text` 的原始字节长度。字节紧跟在元数据后面，
   * 不经过 JSON 编码。
   */
  bytesLength?: number;
  error?: SandboxHostErrorInfo;
}

/** 主线程 → Worker 的同步结果编码（不含 notify）。 */
export function encodeSandboxSyncHostCallResult(result: SandboxSyncHostCallResult): {
  meta: Uint8Array;
  raw?: Uint8Array;
} {
  const encoder = new TextEncoder();
  if (!result.ok) {
    return {
      meta: encoder.encode(
        JSON.stringify({
          ok: false,
          error: result.error ?? bridgeErrorInfo("Sandbox sync host call failed"),
        }),
      ),
    };
  }
  const value = result.value;
  if (value instanceof Uint8Array) {
    return {
      meta: encoder.encode(
        JSON.stringify({ ok: true, valueType: "bytes", bytesLength: value.byteLength }),
      ),
      raw: value,
    };
  }
  if (typeof value === "string") {
    const raw = encoder.encode(value);
    return {
      meta: encoder.encode(
        JSON.stringify({ ok: true, valueType: "text", bytesLength: raw.byteLength }),
      ),
      raw,
    };
  }
  return { meta: encoder.encode(JSON.stringify({ ok: true, valueType: "json", value })) };
}

/**
 * 主线程侧写结果并唤醒 Worker。每次调用恰好 notify 一次；
 * 结果超容量按失败结算，Worker 不会永久挂起。
 */
export function resolveSandboxSyncHostCall(
  signal: SandboxSyncHostCallSignal,
  result: SandboxSyncHostCallResult,
): void {
  const header = new Int32Array(signal.buffer, 0, 4);
  // 幂等守卫：同一 SAB 只结算一次，迟到/重复结算不覆盖已有结果。
  if (Atomics.load(header, 3) === 1) return;
  Atomics.store(header, 3, 1);

  const payload = new Uint8Array(
    signal.buffer,
    SANDBOX_SYNC_SIGNAL_HEADER_BYTES,
    signal.buffer.byteLength - SANDBOX_SYNC_SIGNAL_HEADER_BYTES,
  );
  let encoded: { meta: Uint8Array; raw?: Uint8Array };
  let state = result.ok ? SANDBOX_SYNC_SIGNAL_STATE_OK : SANDBOX_SYNC_SIGNAL_STATE_ERROR;
  try {
    encoded = encodeSandboxSyncHostCallResult(result);
  } catch (error) {
    encoded = encodeSandboxSyncHostCallResult({
      ok: false,
      error: bridgeErrorInfo(error instanceof Error ? error.message : String(error)),
    });
    state = SANDBOX_SYNC_SIGNAL_STATE_ERROR;
  }
  const totalBytes = encoded.meta.byteLength + (encoded.raw?.byteLength ?? 0);
  if (totalBytes > payload.byteLength) {
    encoded = encodeSandboxSyncHostCallResult({
      ok: false,
      error: bridgeErrorInfo("Sandbox sync host call result exceeds the shared buffer capacity"),
    });
    state = SANDBOX_SYNC_SIGNAL_STATE_ERROR;
  }
  payload.set(encoded.meta, 0);
  if (encoded.raw) payload.set(encoded.raw, encoded.meta.byteLength);
  Atomics.store(header, 1, encoded.meta.byteLength + (encoded.raw?.byteLength ?? 0));
  Atomics.store(header, 2, encoded.meta.byteLength);
  Atomics.store(header, 0, state);
  Atomics.notify(header, 0, 1);
}

function bridgeErrorInfo(message: string): SandboxHostErrorInfo {
  return { code: "SANDBOX_FS_SYNC_BRIDGE", message, name: "Error" };
}

function bridgeError(message: string): SandboxSyncHostCallResult {
  return { ok: false, error: bridgeErrorInfo(message) };
}
