// 可调用空壳：同步未支持 / 回调 / 未实现。错误在 guest 侧抛出，保留 err.code。
// 已支持的同步方法由 fs-sync-implemented.ts 覆盖，不在这里装壳。

import type { QuickJS } from "quickjs-wasi";
import {
  SANDBOX_FS_CALLBACK_METHODS,
  SANDBOX_FS_SYNC_UNSUPPORTED,
  SANDBOX_FS_UNSUPPORTED_PROMISE,
  SANDBOX_FS_UNSUPPORTED_ROOT,
} from "./fs-names.js";

/**
 * 不支持方法的替代说明：必须给出真实可用的替代，或明确「异步/同步都未实现」。
 * 不能对所有名字统一说「改用异步 API」。
 */
const SYNC_UNSUPPORTED_HINTS: Record<string, string> = {
  openSync:
    "file descriptors are not available in the sandbox (neither async nor sync). Use readFileSync/writeFileSync for whole files.",
  closeSync: "file descriptors are not available in the sandbox (neither async nor sync).",
  readSync:
    "offset reads on file descriptors are not available (neither async nor sync). Use readFileSync and slice the result.",
  readvSync:
    "offset reads on file descriptors are not available (neither async nor sync). Use readFileSync and slice the result.",
  writeSync:
    "offset writes on file descriptors are not available (neither async nor sync). Use writeFileSync/appendFileSync.",
  writevSync:
    "offset writes on file descriptors are not available (neither async nor sync). Use writeFileSync/appendFileSync.",
  fstatSync:
    "file descriptors are not available in the sandbox (neither async nor sync). Use statSync/lstatSync by path.",
  ftruncateSync:
    "truncate is not implemented (neither async nor sync). Overwrite the file with writeFileSync instead.",
  fsyncSync: "file descriptor sync is not available in the sandbox (neither async nor sync).",
  fdatasyncSync: "file descriptor sync is not available in the sandbox (neither async nor sync).",
  truncateSync:
    "truncate is not implemented (neither async nor sync). Overwrite the file with writeFileSync instead.",
  globSync:
    "glob is not implemented (neither async nor sync). Use readdirSync and filter names yourself.",
  cpSync:
    "recursive copy is not implemented (neither async nor sync). Use readdirSync plus copyFileSync per file.",
  linkSync: "links are not implemented in the sandbox (neither async nor sync).",
  symlinkSync: "links are not implemented in the sandbox (neither async nor sync).",
  readlinkSync: "links are not implemented in the sandbox (neither async nor sync).",
  chmodSync: "permission changes are not implemented in the sandbox (neither async nor sync).",
  lchmodSync: "permission changes are not implemented in the sandbox (neither async nor sync).",
  fchmodSync: "permission changes are not implemented in the sandbox (neither async nor sync).",
  chownSync: "ownership changes are not implemented in the sandbox (neither async nor sync).",
  lchownSync: "ownership changes are not implemented in the sandbox (neither async nor sync).",
  fchownSync: "ownership changes are not implemented in the sandbox (neither async nor sync).",
  utimesSync: "timestamp changes are not implemented in the sandbox (neither async nor sync).",
  lutimesSync: "timestamp changes are not implemented in the sandbox (neither async nor sync).",
  futimesSync: "timestamp changes are not implemented in the sandbox (neither async nor sync).",
  statfsSync: "filesystem statistics are not implemented in the sandbox (neither async nor sync).",
  mkdtempSync:
    "temporary directories are not implemented (neither async nor sync). Use mkdirSync with an explicit path.",
  mkdtempDisposableSync:
    "temporary directories are not implemented (neither async nor sync). Use mkdirSync with an explicit path.",
  opendirSync:
    "directory handles are not implemented (neither async nor sync). Use readdirSync once and iterate the array.",
};

export function installSandboxFsStubs(vm: QuickJS): void {
  const script = `
(function () {
  function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    throw err;
  }
  function unsupportedSync(name) {
    const hints = ${JSON.stringify(SYNC_UNSUPPORTED_HINTS)};
    return function () {
      fail(
        "SANDBOX_FS_UNSUPPORTED",
        "Sandbox does not support " + name + ": " + (hints[name] || "this operation is not implemented async or sync.") + " See the sandbox skill (references/fs.md)."
      );
    };
  }
  function callbackStub(name) {
    return function () {
      fail("SANDBOX_FS_CALLBACK", "Sandbox does not support this callback-only filesystem API (" + name + "). It has no FileSystemPort equivalent.");
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
  var syncNames = ${JSON.stringify(SANDBOX_FS_SYNC_UNSUPPORTED)};
  for (var i = 0; i < syncNames.length; i++) fs[syncNames[i]] = unsupportedSync(syncNames[i]);
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
