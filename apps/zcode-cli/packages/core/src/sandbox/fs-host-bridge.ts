// QuickJS 异步桥：宿主 Promise 经 newPromise 交回；错误带 code 挂到 guest Error 上。
// 参数必须在宿主函数返回前拍成宿主值，因为参数 handle 在返回后失效。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import { fromPortOrUnknown, SANDBOX_FS_NO_HOST, SandboxFsError } from "./fs-errors.js";
import type { SandboxFsCallContext, SandboxFsHostLookup } from "./fs-host-context.js";

export type HostArg =
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "other" };

export function requireFsHost(lookup: SandboxFsHostLookup): SandboxFsCallContext {
  const ctx = lookup();
  if (!ctx) {
    throw new SandboxFsError(SANDBOX_FS_NO_HOST, "Sandbox filesystem host is not configured");
  }
  return ctx;
}

export function isUtf8Encoding(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase().replace("-", "");
  return normalized === "utf8";
}

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
    if (dumped && typeof dumped === "object" && !Array.isArray(dumped)) {
      return { kind: "object", value: dumped as Record<string, unknown> };
    }
  }
  return { kind: "other" };
}

export function hostArgString(arg: HostArg | undefined, label: string): string {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") {
    throw new SandboxFsError("EINVAL", `${label} is required`);
  }
  if (arg.kind === "string") return arg.value;
  if (arg.kind === "number") return String(arg.value);
  throw new SandboxFsError("EINVAL", `${label} must be a string`);
}

export function hostArgEncoding(arg: HostArg | undefined): string | undefined {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return undefined;
  if (arg.kind === "string") return arg.value;
  if (arg.kind === "object" && typeof arg.value.encoding === "string") return arg.value.encoding;
  return undefined;
}

export function hostArgFlag(arg: HostArg | undefined, key: string): boolean {
  if (!arg || arg.kind !== "object") return false;
  return arg.value[key] === true;
}

export function hostArgBytesOrString(arg: HostArg | undefined, label: string): string | Uint8Array {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") {
    throw new SandboxFsError("EINVAL", `${label} is required`);
  }
  if (arg.kind === "string") return arg.value;
  if (arg.kind === "bytes") return arg.value;
  throw new SandboxFsError("EINVAL", `${label} must be a string or Uint8Array`);
}

export function toGuestError(vm: QuickJS, error: unknown): JSValueHandle {
  const fsErr = fromPortOrUnknown(error);
  const handle = vm.newError(fsErr);
  using code = vm.newString(fsErr.code);
  handle.setProp("code", code);
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
