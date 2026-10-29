// ============================================================
// Worker 内 QuickJS 运行时：VM / global / 定时器 / LocalStorage 活态
// ============================================================
// 主线程永不执行 guest JS；本文件是唯一创建 QuickJSFactory 实例的地方。
// console 立即以有序事件上报（CPU 死循环期间主线程也能收到），
// LocalStorage 在每次成功变更后上报 mutation，由主线程维护最后有序快照。
// 定时器由 Worker 自己泵，不依赖主线程 event loop。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import { QuickJS as QuickJSFactory } from "quickjs-wasi";
import { SANDBOX_HEAP_LIMIT_BYTES } from "../constants.js";
import { installSandboxFetch } from "../install-sandbox-fetch.js";
import { installSandboxFs } from "../install-sandbox-fs.js";
import { installSandboxSqlite } from "../install-sandbox-sqlite.js";
import { SandboxLocalStorage, type SandboxLocalStorageSnapshot } from "../local-storage.js";
import { rewriteSandboxImports } from "../rewrite-sandbox-imports.js";
import type {
  SandboxLocalStorageOperation,
  SandboxWorkerEvalResultMessage,
  SandboxWorkerIdentity,
} from "../worker-protocol.js";
import type { SandboxHostCaller } from "../worker-protocol.js";

interface PendingTimer {
  id: number;
  handle: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
  callback: JSValueHandle;
}

interface RuntimeEvents {
  console(method: string, text: string): void;
  localStorage(change: SandboxLocalStorageOperation): void;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

type EvalSettlement =
  | { kind: "settled"; alive: boolean; ok: boolean; returnText?: string; error?: { code: string; message: string } }
  | { kind: "parseError"; error: unknown };

export class SandboxWorkerRuntime {
  private vm: QuickJS | null = null;
  private disposed = false;
  private readonly timers = new Map<number, PendingTimer>();
  private nextTimerId = 1;
  private readonly storage: SandboxLocalStorage;

  constructor(
    private readonly identity: SandboxWorkerIdentity,
    readonly host: SandboxHostCaller,
    private readonly events: RuntimeEvents,
    localStorageSnapshot?: SandboxLocalStorageSnapshot,
  ) {
    this.storage = new SandboxLocalStorage(localStorageSnapshot);
  }

  async start(wasm: BufferSource): Promise<void> {
    const vm = await QuickJSFactory.create({
      wasm,
      memoryLimit: SANDBOX_HEAP_LIMIT_BYTES,
    });
    if (this.disposed) {
      vm.dispose();
      return;
    }
    this.vm = vm;
    this.installGlobals(vm);
  }

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

  async eval(requestId: number, code: string, mode: "model" | "user"): Promise<SandboxWorkerEvalResultMessage> {
    const source = rewriteSandboxImports(code);
    if (mode === "model") {
      return this.toResultMessage(requestId, await this.runWrapped(`;(async () => { ${source} })()`));
    }
    const expression = await this.runWrapped(`;(async () => { return (\n${source}\n) })()`);
    if (expression.kind === "settled") {
      return this.toResultMessage(requestId, expression);
    }
    if (!isSandboxSyntaxError(expression.error)) {
      return this.toResultMessage(requestId, {
        kind: "settled",
        alive: true,
        ok: false,
        error: normalizeSandboxError(expression.error),
      });
    }
    const statement = await this.runWrapped(`;(async () => { ${source} })()`);
    return this.toResultMessage(requestId, statement);
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

  private toResultMessage(
    requestId: number,
    settlement: EvalSettlement,
  ): SandboxWorkerEvalResultMessage {
    if (settlement.kind === "parseError") {
      return {
        ...this.identity,
        type: "eval-result",
        requestId,
        alive: true,
        ok: false,
        error: normalizeSandboxError(settlement.error),
        ...this.heapBytesPayload(),
      };
    }
    return {
      ...this.identity,
      type: "eval-result",
      requestId,
      alive: settlement.alive,
      ok: settlement.ok,
      ...(settlement.returnText !== undefined ? { returnText: settlement.returnText } : {}),
      ...(settlement.error !== undefined ? { error: settlement.error } : {}),
      ...this.heapBytesPayload(),
    };
  }

  private heapBytesPayload(): { heapBytes: number } | undefined {
    const heapBytes = this.heapBytes();
    return heapBytes === undefined ? undefined : { heapBytes };
  }

  /**
   * 包裹源码的执行内核：evalCode 同步抛错（解析期 SyntaxError）与 settled 结果
   * 分开交回，由调用方决定是否回退另一种模式。
   */
  private async runWrapped(
    wrapped: string,
  ): Promise<EvalSettlement> {
    const vm = this.vm;
    if (this.disposed || !vm) {
      return {
        kind: "settled",
        alive: false,
        ok: false,
        error: { code: "sandbox_disposed", message: "沙盒实例已销毁" },
      };
    }
    let settlement: JSValueHandle;
    try {
      settlement = vm.evalCode(wrapped, "<sandbox>");
    } catch (error) {
      return { kind: "parseError", error };
    }
    try {
      // resolvePromise 对 pending promise 只是挂 then，必须靠宿主侧泵
      // executePendingJobs 才会结算；纯 microtask 的顶层 await 先泵一轮。
      vm.executePendingJobs();
      const outcome = await vm.resolvePromise(settlement);
      vm.executePendingJobs();
      if ("error" in outcome) {
        const error = normalizeSandboxErrorValue(vm, outcome.error);
        outcome.error.dispose();
        return { kind: "settled", alive: true, ok: false, error };
      }
      const returnText = stringifySandboxValue(vm, outcome.value);
      outcome.value.dispose();
      return {
        kind: "settled",
        alive: true,
        ok: true,
        ...(returnText === undefined ? {} : { returnText }),
      };
    } catch (error) {
      // host 回调抛错导致 VM 已坏：保守起见标记实例不可用，调用方重建。
      return {
        kind: "settled",
        alive: false,
        ok: false,
        error: normalizeSandboxError(error),
      };
    } finally {
      try {
        settlement.dispose();
      } catch {
        // dispose 幂等：VM 已坏时释放失败不掩盖本次结果。
      }
    }
  }

  private installGlobals(vm: QuickJS): void {
    // console：收集到主线程环形缓冲（五方法同形，文本拼接对齐 node-repl 的 emit）。
    {
      using consoleObj = vm.newObject();
      for (const method of CONSOLE_METHODS) {
        using fn = vm.newFunction(`console.${method}`, (...args) => {
          const text = args.map((arg) => stringifySandboxArg(vm, arg)).join(" ");
          this.events.console(method, text);
          return vm.undefined;
        });
        vm.setProp(consoleObj, method, fn);
      }
      vm.setProp(vm.global, "console", consoleObj);
    }
    // 定时器：Worker 侧泵。到点后把回调 dup 出来的 handle 灌回 VM 执行，
    // 再排空 microtask；实例销毁时清掉宿主定时器，残留回调不再执行。
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
    // LocalStorage：浏览器形；每次成功变更后上报 mutation，主线程按序应用并落盘。
    {
      using storageObj = vm.newObject();
      const storage = this.storage;
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
        const key = keyHandle.toString();
        const value = valueHandle === undefined ? "undefined" : valueHandle.toString();
        storage.setItem(key, value);
        this.events.localStorage({ op: "set", key, value });
        return vm.undefined;
      });
      define("removeItem", (keyHandle) => {
        const key = keyHandle.toString();
        storage.removeItem(key);
        this.events.localStorage({ op: "remove", key });
        return vm.undefined;
      });
      define("clear", () => {
        storage.clear();
        this.events.localStorage({ op: "clear" });
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
    installSandboxFs(vm, this.host);
    installSandboxFetch(vm, this.host);
    installSandboxSqlite(vm, this.host);
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
      // 定时器回调抛错不杀实例：记一行 console error，语义对齐浏览器。
      this.events.console("error", normalizeSandboxError(error).message);
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
