// 可调用空壳：同步 / 回调 / 未实现。错误在 guest 侧抛出，保留 err.code。

import type { QuickJS } from "quickjs-wasi";
import {
  SANDBOX_FS_CALLBACK_METHODS,
  SANDBOX_FS_SYNC_METHODS,
  SANDBOX_FS_UNSUPPORTED_PROMISE,
  SANDBOX_FS_UNSUPPORTED_ROOT,
} from "./fs-names.js";

export function installSandboxFsStubs(vm: QuickJS): void {
  const script = `
(function () {
  function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    throw err;
  }
  function syncStub(name) {
    return function () {
      fail("SANDBOX_FS_SYNC", "Sandbox has no synchronous fs (" + name + "). Use fs.promises instead.");
    };
  }
  function callbackStub(name) {
    return function () {
      fail("SANDBOX_FS_CALLBACK", "Sandbox has no callback fs (" + name + "). Use fs.promises instead.");
    };
  }
  function unsupportedStub(name) {
    return function () {
      const err = new Error("Sandbox has not implemented " + name + ". Load the sandbox skill (references/fs.md).");
      err.code = "SANDBOX_FS_UNSUPPORTED";
      return Promise.reject(err);
    };
  }
  function unsupportedThrow(name) {
    return function () {
      fail("SANDBOX_FS_UNSUPPORTED", "Sandbox has not implemented " + name + ". Load the sandbox skill (references/fs.md).");
    };
  }
  var syncNames = ${JSON.stringify(SANDBOX_FS_SYNC_METHODS)};
  for (var i = 0; i < syncNames.length; i++) fs[syncNames[i]] = syncStub(syncNames[i]);
  var callbackNames = ${JSON.stringify(SANDBOX_FS_CALLBACK_METHODS)};
  for (var j = 0; j < callbackNames.length; j++) fs[callbackNames[j]] = callbackStub(callbackNames[j]);
  var unsupportedRoot = ${JSON.stringify(SANDBOX_FS_UNSUPPORTED_ROOT)};
  for (var k = 0; k < unsupportedRoot.length; k++) fs[unsupportedRoot[k]] = unsupportedThrow(unsupportedRoot[k]);
  var unsupportedPromise = ${JSON.stringify(SANDBOX_FS_UNSUPPORTED_PROMISE)};
  for (var n = 0; n < unsupportedPromise.length; n++) {
    fs.promises[unsupportedPromise[n]] = unsupportedStub(unsupportedPromise[n]);
  }
  fs.promises.realpath.native = unsupportedStub("realpath.native");
})();
`;
  vm.evalCode(script).dispose();
}
