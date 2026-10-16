// 根 fs 的回调形式复用同一 Promise 实现，权限与路径检查不另开分支。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import { snapshotHostArg, toGuestError, type HostArg } from "./fs-host-bridge.js";
import { SANDBOX_FS_CALLBACK_IMPLEMENTED } from "./fs-names.js";

export function attachImplementedCallbacks(
  vm: QuickJS,
  fs: JSValueHandle,
  operations: Record<(typeof SANDBOX_FS_CALLBACK_IMPLEMENTED)[number], (args: HostArg[]) => Promise<JSValueHandle>>,
): void {
  for (const name of SANDBOX_FS_CALLBACK_IMPLEMENTED) {
    using callbackFn = vm.newFunction(`fs.${name}`, (...args) => {
      const callback = args.at(-1);
      if (!callback?.isFunction) {
        throw new TypeError('The "callback" argument must be of type function');
      }
      const callbackHandle = callback.dup();
      const operationArgs = args.slice(0, -1).map((arg) => snapshotHostArg(vm, arg));
      const operation = operations[name](operationArgs);
      void operation.then(
        (result) => {
          try {
            using nullValue = vm.null;
            using callbackResult = result.dup();
            using thisValue = fs.dup();
            vm.callFunction(callbackHandle, thisValue, nullValue, callbackResult).dispose();
            vm.executePendingJobs();
          } catch {
            // 实例已销毁时，回调结算作废。
          } finally {
            result.dispose();
            callbackHandle.dispose();
          }
        },
        (error) => {
          try {
            using callbackError = toGuestError(vm, error);
            using undefinedValue = vm.undefined;
            using thisValue = fs.dup();
            vm.callFunction(callbackHandle, thisValue, callbackError, undefinedValue).dispose();
            vm.executePendingJobs();
          } catch {
            // 实例已销毁时，回调结算作废。
          } finally {
            callbackHandle.dispose();
          }
        },
      );
      return vm.undefined;
    });
    vm.setProp(fs, name, callbackFn);
  }
}
