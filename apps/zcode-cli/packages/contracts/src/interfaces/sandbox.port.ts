// ============================================================
// Sandbox Port - 会话级 QuickJS 隔离计算面的执行边界
// ============================================================
// 唯一活实例所有者是调用方的会话级 Sandbox 端口实现（core 的 src/sandbox/，
// 阶段1落）。本文件只定契约：按会话获取/创建活实例、eval、读 console 窗口、
// 重置（保留 LocalStorage）、dispose、堆占用、是否需要新实例提示。
//
// 规则见 docs/specs/sandbox-system-tool.md。执行权威在 CLI/runtime 的沙盒端口，
// 不在 UI；QuickJS 不进宿主 Node 的 vm（那不是隔离），引擎侧跑 WASM QuickJS。

import type { SessionId } from "./shared.js";

/** wire/磁盘形态：键值均为字符串（与浏览器 LocalStorage 一致）。 */
export type SandboxLocalStorageSnapshot = Record<string, string>;

/** 沙盒 eval 的单条 console 行（环形缓冲的投影元素）。 */
export interface SandboxConsoleLine {
  /** 追加到环形缓冲时的单调序号（会话级实例内递增）。 */
  seq: number;
  /** 写入时的墙钟（unix ms）。后台窗口查询按它裁剪。 */
  at: number;
  /** console 方法名（log/info/warn/error/debug）。 */
  method: string;
  /** 该行的文本投影（多参数按空格拼接后的结果）。 */
  text: string;
}

/** eval 一次调用的结构化结果。三种形态互斥。 */
export type SandboxEvalResult =
  | {
      kind: "completed";
      /** `return` 交回值的文本投影；转不了标类型，仍算成功（字段缺席即无 return）。 */
      returnText?: string;
      /** 该次调用开始 → 交回时刻之间新产生的 console 行（含残留定时器的交错输出）。 */
      consoleLines: SandboxConsoleLine[];
      consoleTruncated: boolean;
    }
  | {
      kind: "failed";
      error: { code: string; message: string };
      consoleLines: SandboxConsoleLine[];
      consoleTruncated: boolean;
    }
  | {
      kind: "backgrounded";
      backgroundTaskId: string;
    };

export interface SandboxEvalRequest {
  sessionId: SessionId;
  /** 必须提供的内联源码。 */
  code: string;
  /** 整段 eval 的墙钟（ms）。钳制归工具层；端口只按值执行，超时摘的是等待不是 JS。 */
  timeoutMs: number;
  /** 显式要求在后台跑（阶段4前调用方不得传 true）。 */
  runInBackground?: boolean;
  /** 先销毁当前实例再在新实例里执行本次；LocalStorage 保留（阶段3前调用方不得传 true）。 */
  resetBeforeRun?: boolean;
}

export interface SandboxEvalOptions {
  signal?: AbortSignal;
}

export interface SandboxEvalOutcome {
  result: SandboxEvalResult;
  /** 本次调用后实例是否存活（false = 已按 128MB 硬顶销毁，调用方下次建新实例）。 */
  instanceAlive: boolean;
  /** 新建实例后的第一次调用为 true（调用方据此包一次新实例提示，只写一次）。 */
  isFirstResultOnNewInstance: boolean;
}

/**
 * 会话级 Sandbox 端口：每 sessionId 一份活实例（含子代理各用各的实例，互不可见）。
 * 堆/全局/定时器/当前交错的 eval 归实例；LocalStorage 归磁盘（重启仍在，删会话才清）。
 */
export interface SandboxPort {
  /** 在活实例上 eval 一段代码（同步语义由阶段2/4的工具层决定前台/后台）。 */
  eval(request: SandboxEvalRequest, options?: SandboxEvalOptions): Promise<SandboxEvalOutcome>;
  /** 读 console 环形缓冲的窗口（后台 TaskOutput 按调用开始 → 读取时刻裁剪）。 */
  readConsoleWindow(
    sessionId: SessionId,
    input: { fromSeq?: number; sinceMs?: number; filter?: string; limit?: number },
  ): Promise<{ lines: SandboxConsoleLine[]; truncated: boolean }>;
  /** 销毁实例再建新实例；LocalStorage 保留；在途调用按失败结算。 */
  reset(sessionId: SessionId): Promise<void>;
  /** 释放实例（runtime/session close、常驻池回收、进程退出走这里）。 */
  dispose(sessionId: SessionId): void;
  /** 活实例的堆占用字节（不含 LocalStorage；超 128MB 由实现侧销毁）。 */
  heapBytes(sessionId: SessionId): number | undefined;
  /** 活实例是否仍在内存（状态面板「沙盒」分区的开门事实）。 */
  hasLiveInstance(sessionId: SessionId): boolean;
}
