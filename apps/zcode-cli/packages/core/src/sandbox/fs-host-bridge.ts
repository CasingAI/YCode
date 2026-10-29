// QuickJS 异步桥：宿主 Promise 经 newPromise 交回；错误带 code/name 挂到 guest Error 上。
// 参数必须在宿主函数返回前拍成宿主值，因为参数 handle 在返回后失效。
// 本文件只跑在 Worker 内（guest 侧），不持有任何主线程端口。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import {
  SandboxHostError,
  sandboxHostErrorInfo,
  type HostArg,
} from "./host-args.js";

export type { HostArg } from "./host-args.js";

export function snapshotHostArg(vm: QuickJS, handle: JSValueHandle | undefined): HostArg {
  if (!handle || handle.isUndefined) return { kind: "undefined" };
  if (handle.isNull) return { kind: "null" };
  if (handle.isString) return { kind: "string", value: handle.toString() };
  if (handle.isNumber) return { kind: "number", value: handle.toNumber() };
  if (handle.isBool) return { kind: "boolean", value: handle.toNumber() !== 0 };
  if (handle.constructorName === "Uint8Array") {
    return { kind: "bytes", value: new Uint8Array(handle.toUint8Array()) };
  }
  if (handle.isObject) {
    const dumped = vm.dump(handle);
    if (typeof dumped === "string") return { kind: "string", value: dumped };
    if (Array.isArray(dumped)) return { kind: "array", value: dumped as unknown[] };
    if (dumped && typeof dumped === "object") {
      return { kind: "object", value: dumped as Record<string, unknown> };
    }
  }
  return { kind: "other" };
}

/**
 * 错误 → guest Error：保留 name 与 code（fetch 的 AbortError、FS 的 ENOENT 等）。
 * 跨线程只传三元组，不传宿主错误对象。
 */
export function toGuestError(vm: QuickJS, error: unknown): JSValueHandle {
  const info = sandboxHostErrorInfo(error);
  const handle = vm.newError(new SandboxHostError(info.code, info.message, info.name));
  using code = vm.newString(info.code);
  handle.setProp("code", code);
  if (info.name !== "Error") {
    using name = vm.newString(info.name);
    handle.setProp("name", name);
  }
  return handle;
}

function isCachedSingleton(vm: QuickJS, value: JSValueHandle): boolean {
  return value === vm.undefined || value === vm.null || value === vm.true || value === vm.false;
}

export function hostAsyncFunction(
  vm: QuickJS,
  name: string,
  run: (args: HostArg[]) => Promise<JSValueHandle>,
): JSValueHandle {
  return vm.newFunction(name, (...args) => {
    const deferred = vm.newPromise();
    let snapshot: HostArg[];
    try {
      snapshot = args.map((arg) => snapshotHostArg(vm, arg));
    } catch (error) {
      rejectDeferred(vm, deferred, error);
      return deferred.handle;
    }
    void run(snapshot).then(
      (value) => {
        try {
          deferred.resolve(value);
          if (!isCachedSingleton(vm, value)) value.dispose();
          vm.executePendingJobs();
        } catch {
          // VM 已销毁：这次结算作废。
        }
      },
      (error) => {
        rejectDeferred(vm, deferred, error);
      },
    );
    return deferred.handle;
  });
}

function rejectDeferred(vm: QuickJS, deferred: ReturnType<QuickJS["newPromise"]>, error: unknown): void {
  try {
    const guest = toGuestError(vm, error);
    deferred.reject(guest);
    guest.dispose();
    vm.executePendingJobs();
  } catch {
    // VM 已销毁。
  }
}
