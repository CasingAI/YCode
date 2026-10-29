// 往 Worker 内的活实例安装 Node 形 fs / path / 受限 require。
// 真做经宿主桥走主线程端口；空壳在 guest 侧拒绝。

import { basename, dirname, extname, join } from "node:path";
import type { QuickJS } from "quickjs-wasi";
import { installSandboxFsShapes } from "./fs-node-shapes.js";
import { attachImplementedPromises } from "./fs-promises-implemented.js";
import { attachImplementedCallbacks } from "./fs-callback-implemented.js";
import { installSandboxFsSync } from "./fs-sync-implemented.js";
import { installSandboxRequire, registerSandboxRequireModule } from "./install-sandbox-require.js";
import { installSandboxFsStubs } from "./fs-stubs.js";
import type { SandboxHostCaller } from "./worker-protocol.js";

function attachPath(vm: QuickJS): void {
  using pathObj = vm.newObject();
  using joinFn = vm.newFunction("path.join", (...args) =>
    vm.newString(join(...args.map((arg) => arg.toString()))),
  );
  using dirnameFn = vm.newFunction("path.dirname", (...args) =>
    vm.newString(dirname(args[0] === undefined ? "" : args[0].toString())),
  );
  using basenameFn = vm.newFunction("path.basename", (...args) =>
    vm.newString(
      basename(
        args[0] === undefined ? "" : args[0].toString(),
        args[1] === undefined || args[1].isUndefined ? undefined : args[1].toString(),
      ),
    ),
  );
  using extnameFn = vm.newFunction("path.extname", (...args) =>
    vm.newString(extname(args[0] === undefined ? "" : args[0].toString())),
  );
  vm.setProp(pathObj, "join", joinFn);
  vm.setProp(pathObj, "dirname", dirnameFn);
  vm.setProp(pathObj, "basename", basenameFn);
  vm.setProp(pathObj, "extname", extnameFn);
  vm.setProp(vm.global, "path", pathObj);
}

function attachConstants(vm: QuickJS, target: ReturnType<QuickJS["newObject"]>): void {
  using constants = vm.newObject();
  using fOk = vm.newNumber(0);
  using rOk = vm.newNumber(4);
  using wOk = vm.newNumber(2);
  vm.setProp(constants, "F_OK", fOk);
  vm.setProp(constants, "R_OK", rOk);
  vm.setProp(constants, "W_OK", wOk);
  vm.setProp(target, "constants", constants);
}

export function installSandboxFs(vm: QuickJS, host: SandboxHostCaller): void {
  installSandboxRequire(vm);
  const shapes = installSandboxFsShapes(vm);
  using fsObj = vm.newObject();
  using promises = vm.newObject();
  const operations = attachImplementedPromises(vm, promises, host, shapes);
  attachConstants(vm, promises);
  attachConstants(vm, fsObj);
  vm.setProp(fsObj, "promises", promises);
  vm.setProp(vm.global, "fs", fsObj);
  attachPath(vm);
  installSandboxFsStubs(vm);
  using installedFs = vm.global.getProp("fs");
  attachImplementedCallbacks(vm, installedFs, operations);
  // 支持的 *Sync 方法必须最后装：覆盖 fs-stubs 里同名的不支持空壳。
  installSandboxFsSync(vm, host);
  using fsGlobal = vm.global.getProp("fs");
  registerSandboxRequireModule(vm, "fs", fsGlobal);
  registerSandboxRequireModule(vm, "node:fs", fsGlobal);
  using promisesGlobal = vm.global.getProp("fs");
  using promisesObj = promisesGlobal.getProp("promises");
  registerSandboxRequireModule(vm, "fs/promises", promisesObj);
  registerSandboxRequireModule(vm, "node:fs/promises", promisesObj);
  using pathGlobal = vm.global.getProp("path");
  registerSandboxRequireModule(vm, "path", pathGlobal);
  registerSandboxRequireModule(vm, "node:path", pathGlobal);
}
