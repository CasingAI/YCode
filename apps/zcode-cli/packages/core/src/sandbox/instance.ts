// ============================================================
// Sandbox 实例：单个 QuickJS VM 的宿主封装
// ============================================================
// 一份实例 = 一个 QuickJS VM + console 环 + LocalStorage 内存态 + 定时器泵。
// 销毁 = dispose VM + 清 host 定时器（残留回调不再灌回）；堆内存超 128MB
// 由宿主侧 getMemoryUsage 观测到后销毁（异常路径见 instance-table.ts）。
//
// 作用域隔离：源码用函数作用域包一层再 eval，只有赋给全局的值跨调用可见
// （符合 spec「不挂全局不保存」）。`return` 在包装函数内合法，直通交回。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import { QuickJS as QuickJSFactory } from "quickjs-wasi";
import type { SandboxConsoleLine, SandboxEvalResult } from "@zcode/contracts";
import { SandboxConsoleRing } from "./console-ring.js";
import { SANDBOX_HEAP_LIMIT_BYTES } from "./constants.js";
import type { SandboxFetchHostLookup, SandboxInstanceFetchHost } from "./fetch-host-context.js";
import type { SandboxFsHostLookup, SandboxInstanceFsHost } from "./fs-host-context.js";
import { installSandboxFetch } from "./install-sandbox-fetch.js";
import { installSandboxFs } from "./install-sandbox-fs.js";
import {
  installSandboxSqlite,
  type SandboxInstanceSqliteHost,
  type SandboxSqliteHostLookup,
} from "./install-sandbox-sqlite.js";
import { SandboxLocalStorage, type SandboxLocalStorageSnapshot } from "./local-storage.js";
import { rewriteSandboxImports } from "./rewrite-sandbox-imports.js";

export interface SandboxInstanceEvalOutcome {
  result: SandboxEvalResult;
  /** 本次 eval 后实例是否仍可用（false = host 回调抛错导致 VM 已坏，调用方重建）。 */
  alive: boolean;
}

interface PendingTimer {
  id: number;
  handle: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
  callback: JSValueHandle;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

export class SandboxInstance {
  private vm: QuickJS | null;
  private disposed = false;
  private readonly timers = new Map<number, PendingTimer>();
  private nextTimerId = 1;
  readonly consoleRing = new SandboxConsoleRing();
  readonly localStorage: SandboxLocalStorage;
  private readonly fsLookup: SandboxFsHostLookup;
  private readonly fetchLookup: SandboxFetchHostLookup;
  private readonly sqliteLookup: SandboxSqliteHostLookup;

  private constructor(
    vm: QuickJS,
    localStorageSnapshot: SandboxLocalStorageSnapshot | undefined,
    fsHost: SandboxInstanceFsHost | undefined,
    fetchHost: SandboxInstanceFetchHost | undefined,
    sqliteHost?: SandboxInstanceSqliteHost,
  ) {
    this.vm = vm;
    this.localStorage = new SandboxLocalStorage(localStorageSnapshot);
    this.fsLookup = fsHost?.resolve ?? (() => undefined);
    this.fetchLookup = fetchHost?.resolve ?? (() => undefined);
    this.sqliteLookup = sqliteHost?.resolve ?? (() => undefined);
    this.installGlobals(vm);
  }

  static async create(
    localStorageSnapshot?: SandboxLocalStorageSnapshot,
    fsHost?: SandboxInstanceFsHost,
    fetchHost?: SandboxInstanceFetchHost,
    sqliteHost?: SandboxInstanceSqliteHost,
  ): Promise<SandboxInstance> {
    const vm = await QuickJSFactory.create({ memoryLimit: SANDBOX_HEAP_LIMIT_BYTES });
    return new SandboxInstance(vm, localStorageSnapshot, fsHost, fetchHost, sqliteHost);
  }

  /** 堆占用字节（不含 LocalStorage 磁盘态；含 VM 内 LocalStorage 内存态，属保守口径）。 */
  heapBytes(): number | undefined {
    if (this.disposed || !this.vm) return undefined;
    try {
      return this.vm.getMemoryUsage().memoryUsedSize;
    } catch {
      return undefined;
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  async eval(code: string): Promise<SandboxInstanceEvalOutcome> {
    const fromSeq = this.consoleRing.watermark();
    const source = rewriteSandboxImports(code);
    const settled = await this.runWrapped(`;(async () => { ${source} })()`, fromSeq);
    if (settled.kind === "parseError") {
      // 语法错 / 同步抛错：活实例留下（语法错可能根本没跑）。
      return {
        alive: true,
        result: {
          kind: "failed",
          error: normalizeSandboxError(settled.error),
          ...this.consoleRing.evalWindow({ fromSeq }),
        },
      };
    }
    return settled.outcome;
  }

  /**
   * 控制台用户 eval（DevTools 语义）：先按纯表达式求值（`1+1` 直接交回 `2`，
   * 顶层 await 自然结算），不要求用户写 `return`；只有同步 SyntaxError 才回退
   * 语句模式（`let`/`if`/`function` 等按语句语义执行，无交回值）。
   * 原因与修复依据：evalCode 同步抛错发生在解析期、无任何副作用，不会跑两遍；
   * 运行时抛错（ReferenceError 等）已是 settled failed，不回退。模型工具链路
   * 走 eval()，`return` 协议不变。
   */
  async evalUser(code: string): Promise<SandboxInstanceEvalOutcome> {
    const fromSeq = this.consoleRing.watermark();
    const source = rewriteSandboxImports(code);
    const expression = await this.runWrapped(`;(async () => { return (\n${source}\n) })()`, fromSeq);
    if (expression.kind === "settled") return expression.outcome;
    if (!isSandboxSyntaxError(expression.error)) {
      return {
        alive: true,
        result: {
          kind: "failed",
          error: normalizeSandboxError(expression.error),
          ...this.consoleRing.evalWindow({ fromSeq }),
        },
      };
    }
    const statement = await this.runWrapped(`;(async () => { ${source} })()`, fromSeq);
    if (statement.kind === "parseError") {
      return {
        alive: true,
        result: {
          kind: "failed",
          error: normalizeSandboxError(statement.error),
          ...this.consoleRing.evalWindow({ fromSeq }),
        },
      };
    }
    return statement.outcome;
  }

  /**
   * 包裹源码的执行内核：evalCode 同步抛错（解析期 SyntaxError）与 settled 结果
   * 分开交回，由调用方决定是否回退另一种模式。disposed 仍按 settled 失败交回。
   */
  private async runWrapped(
    wrapped: string,
    fromSeq: number,
  ): Promise<
    | { kind: "settled"; outcome: SandboxInstanceEvalOutcome }
    | { kind: "parseError"; error: unknown }
  > {
    const vm = this.vm;
    if (this.disposed || !vm) {
      return {
        kind: "settled",
        outcome: {
          alive: false,
          result: {
            kind: "failed",
            error: { code: "sandbox_disposed", message: "沙盒实例已销毁" },
            consoleLines: [],
            consoleTruncated: false,
          },
        },
      };
    }
    let settlement: JSValueHandle;
    try {
      settlement = vm.evalCode(wrapped, "<sandbox>");
    } catch (error) {
      return { kind: "parseError", error };
    }
    try {
      // 原因与修复依据：resolvePromise 对 pending promise 只是挂 then，必须靠 host
      // 侧泵 executePendingJobs 才会结算；纯 microtask 的顶层 await（如 await
      // Promise.resolve(5)）没有任何 host 定时器来泵，不先泵就永远挂住。先排空
      // 一轮同步可达的 job，host 定时器依赖的剩余部分仍由定时器回调泵。
      vm.executePendingJobs();
      const outcome = await vm.resolvePromise(settlement);
      vm.executePendingJobs();
      if ("error" in outcome) {
        const error = normalizeSandboxErrorValue(vm, outcome.error);
        outcome.error.dispose();
        return { kind: "settled", outcome: { alive: true, result: { kind: "failed", error, ...this.consoleRing.evalWindow({ fromSeq }) } } };
      }
      const returnText = stringifySandboxValue(vm, outcome.value);
      outcome.value.dispose();
      return {
        kind: "settled",
        outcome: {
          alive: true,
          result: { kind: "completed", ...(returnText === undefined ? {} : { returnText }), ...this.consoleRing.evalWindow({ fromSeq }) },
        },
      };
    } catch (error) {
      // host 回调抛错导致 VM 已坏：保守起见标记实例不可用，调用方重建。
      return {
        kind: "settled",
        outcome: {
          alive: false,
          result: {
            kind: "failed",
            error: normalizeSandboxError(error),
            ...this.consoleRing.evalWindow({ fromSeq }),
          },
        },
      };
    } finally {
      try {
        settlement.dispose();
      } catch {
        // dispose 幂等：VM 已坏时释放失败不掩盖本次结果。
      }
    }
  }

  /** 读 console 窗口（后台 TaskOutput 与控制台投影共用）。 */
  readConsoleWindow(input: { filter?: string; fromSeq?: number; limit?: number } = {}): {
    lines: SandboxConsoleLine[];
    truncated: boolean;
  } {
    return this.consoleRing.window(input);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) {
      if (timer.handle !== null) clearTimeout(timer.handle);
      if (timer.interval !== null) clearInterval(timer.interval);
      try {
        timer.callback.dispose();
      } catch {
        // 释放幂等：VM 已坏时不抛。
      }
    }
    this.timers.clear();
    try {
      this.vm?.dispose();
    } catch {
      // dispose 幂等。
    }
    this.vm = null;
  }

  private installGlobals(vm: QuickJS): void {
    // console：收集到环形缓冲（五方法同形，文本拼接对齐 node-repl 的 emit）。
    {
      using consoleObj = vm.newObject();
      for (const method of CONSOLE_METHODS) {
        using fn = vm.newFunction(`console.${method}`, (...args) => {
          const text = args.map((arg) => stringifySandboxArg(vm, arg)).join(" ");
          this.consoleRing.push(method, text);
          return vm.undefined;
        });
        vm.setProp(consoleObj, method, fn);
      }
      vm.setProp(vm.global, "console", consoleObj);
    }
    // 定时器：host 侧泵。到点后把回调 dup 出来的 handle 灌回 VM 执行，
    // 再排空 microtask；实例销毁时清掉 host 定时器，残留回调不再执行。
    {
      using setTimeoutFn = vm.newFunction("setTimeout", (...args) => {
        const callback = args[0]?.dup();
        const delayMs = args[1] !== undefined ? args[1].toNumber() : 0;
        if (!callback || callback.isUndefined || callback.isNull) {
          callback?.dispose();
          throw new Error("setTimeout 需要一个回调函数");
        }
        const id = this.nextTimerId++;
        const entry: PendingTimer = { id, handle: null, interval: null, callback };
        entry.handle = setTimeout(() => {
          this.timers.delete(id);
          this.fireTimer(entry);
        }, Math.max(0, Number.isFinite(delayMs) ? delayMs : 0));
        this.timers.set(id, entry);
        return vm.newNumber(id);
      });
      vm.setProp(vm.global, "setTimeout", setTimeoutFn);
    }
    {
      using clearTimeoutFn = vm.newFunction("clearTimeout", (...args) => {
        const id = args[0]?.toNumber();
        const entry = typeof id === "number" ? this.timers.get(id) : undefined;
        if (entry?.handle !== null && entry?.handle !== undefined) clearTimeout(entry.handle);
        if (entry) {
          this.timers.delete(entry.id);
          try {
            entry.callback.dispose();
          } catch {
            // 释放幂等。
          }
        }
        return vm.undefined;
      });
      vm.setProp(vm.global, "clearTimeout", clearTimeoutFn);
    }
    {
      using setIntervalFn = vm.newFunction("setInterval", (...args) => {
        const callback = args[0]?.dup();
        const delayMs = args[1] !== undefined ? args[1].toNumber() : 0;
        if (!callback || callback.isUndefined || callback.isNull) {
          callback?.dispose();
          throw new Error("setInterval 需要一个回调函数");
        }
        const id = this.nextTimerId++;
        const entry: PendingTimer = { id, handle: null, interval: null, callback };
        entry.interval = setInterval(() => {
          this.fireTimer(entry, true);
        }, Math.max(0, Number.isFinite(delayMs) ? delayMs : 0));
        this.timers.set(id, entry);
        return vm.newNumber(id);
      });
      vm.setProp(vm.global, "setInterval", setIntervalFn);
    }
    {
      using clearIntervalFn = vm.newFunction("clearInterval", (...args) => {
        const id = args[0]?.toNumber();
        const entry = typeof id === "number" ? this.timers.get(id) : undefined;
        if (entry?.interval !== null && entry?.interval !== undefined) clearInterval(entry.interval);
        if (entry) {
          this.timers.delete(entry.id);
          try {
            entry.callback.dispose();
          } catch {
            // 释放幂等。
          }
        }
        return vm.undefined;
      });
      vm.setProp(vm.global, "clearInterval", clearIntervalFn);
    }
    // LocalStorage：浏览器形（length/key/getItem/setItem/removeItem/clear），
    // 配额错以 JS 侧 QuotaExceededError 形抛给脚本；脚本没接住按普通抛错处理。
    {
      using storageObj = vm.newObject();
      const storage = this.localStorage;
      const define = (name: string, fn: (...args: JSValueHandle[]) => JSValueHandle) => {
        using handle = vm.newFunction(`localStorage.${name}`, function (this: JSValueHandle, ...callArgs: JSValueHandle[]) {
          return fn(...callArgs);
        });
        vm.setProp(storageObj, name, handle);
      };
      define("getItem", (keyHandle) => {
        const value = storage.getItem(keyHandle.toString());
        return value === null ? vm.null : vm.newString(value);
      });
      define("setItem", (keyHandle, valueHandle) => {
        storage.setItem(keyHandle.toString(), valueHandle === undefined ? "undefined" : valueHandle.toString());
        return vm.undefined;
      });
      define("removeItem", (keyHandle) => {
        storage.removeItem(keyHandle.toString());
        return vm.undefined;
      });
      define("clear", () => {
        storage.clear();
        return vm.undefined;
      });
      define("key", (indexHandle) => {
        const key = storage.key(indexHandle.toNumber());
        return key === null ? vm.null : vm.newString(key);
      });
      Object.defineProperty(storageObj, "length", {
        // host 侧无用占位：真正的 length 语义由下面的 accessor eval 覆盖。
        value: undefined,
        enumerable: false,
      });
      vm.setProp(vm.global, "localStorage", storageObj);
      // length 走 accessor 语义：每次读都调 host 回调，保证脚本读到最新值。
      vm.evalCode("Object.defineProperty(localStorage, 'length', { get() { return __sandboxLocalStorageCount(); }, enumerable: true });").dispose();
      using countFn = vm.newFunction("__sandboxLocalStorageCount", () => vm.newNumber(storage.length));
      vm.setProp(vm.global, "__sandboxLocalStorageCount", countFn);
    }
    installSandboxFs(vm, () => this.fsLookup());
    installSandboxFetch(vm, () => this.fetchLookup());
    installSandboxSqlite(vm, () => this.sqliteLookup(), () => this.fsLookup());
  }

  private fireTimer(entry: PendingTimer, repeat = false): void {
    const vm = this.vm;
    if (this.disposed || !vm) {
      if (!repeat) {
        try {
          entry.callback.dispose();
        } catch {
          // 释放幂等。
        }
      }
      return;
    }
    try {
      vm.callFunction(entry.callback, vm.global).dispose();
      vm.executePendingJobs();
    } catch (error) {
      // 定时器回调抛错不杀实例：记一行 console error，语义对齐浏览器（异常冒到窗口）。
      this.consoleRing.push("error", normalizeSandboxError(error).message);
    } finally {
      if (!repeat) {
        this.timers.delete(entry.id);
        try {
          entry.callback.dispose();
        } catch {
          // 释放幂等。
        }
      }
    }
  }
}

/** 不能稳定序列化的返回值尽量转成文本（类似控制台预览），转不了标类型，仍算成功。 */
function stringifySandboxValue(vm: QuickJS, handle: JSValueHandle): string | undefined {
  if (handle.isUndefined) return undefined;
  if (handle.isNull) return "null";
  try {
    const dumped = vm.dump(handle);
    if (typeof dumped === "string") return dumped;
    if (typeof dumped === "number" || typeof dumped === "boolean" || typeof dumped === "bigint") {
      return String(dumped);
    }
    try {
      return JSON.stringify(dumped) ?? handle.typeof;
    } catch {
      return handle.typeof;
    }
  } catch {
    try {
      return handle.toString();
    } catch {
      return handle.typeof;
    }
  }
}

function stringifySandboxArg(vm: QuickJS, handle: JSValueHandle): string {
  const text = stringifySandboxValue(vm, handle);
  return text === undefined ? "undefined" : text;
}

function normalizeSandboxError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: error.name || "Error", message: error.message || String(error) };
  }
  return { code: "Error", message: String(error) };
}

/**
 * 解析期 SyntaxError 判定（表达式→语句回退的唯一闸门）：只认 evalCode 同步抛错
 * 且 name 为 SyntaxError。运行时抛出的同名错误已是 settled failed，不进这里。
 */
function isSandboxSyntaxError(error: unknown): boolean {
  return error instanceof Error && error.name === "SyntaxError";
}

function normalizeSandboxErrorValue(
  vm: QuickJS,
  handle: JSValueHandle,
): { code: string; message: string } {
  try {
    const dumped = vm.dump(handle);
    if (dumped instanceof Error) return { code: dumped.name || "Error", message: dumped.message };
    if (typeof dumped === "object" && dumped !== null) {
      const record = dumped as Record<string, unknown>;
      const message = typeof record.message === "string" ? record.message : String(dumped);
      const code = typeof record.name === "string" ? record.name : "Error";
      return { code, message };
    }
    return { code: "Error", message: String(dumped) };
  } catch {
    try {
      return { code: handle.constructorName ?? "Error", message: handle.toString() };
    } catch {
      return { code: "Error", message: "未知错误" };
    }
  }
}
