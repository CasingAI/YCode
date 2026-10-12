// 往活实例安装 Node 形 fs / path / 受限 require。真做走端口，空壳在 guest 侧拒绝。

import { basename, dirname, extname, join } from "node:path";
import type { QuickJS } from "quickjs-wasi";
import type { SandboxFsHostLookup } from "./fs-host-context.js";
import { installSandboxFsShapes } from "./fs-node-shapes.js";
import { attachImplementedPromises } from "./fs-promises-implemented.js";
import { installSandboxFsStubs } from "./fs-stubs.js";

export type { SandboxFsHostLookup, SandboxFsCallContext, SandboxInstanceFsHost, SandboxFsHostPaths } from "./fs-host-context.js";

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

export function installSandboxFs(vm: QuickJS, lookup: SandboxFsHostLookup): void {
  const shapes = installSandboxFsShapes(vm);
  using fsObj = vm.newObject();
  using promises = vm.newObject();
  attachImplementedPromises(vm, promises, lookup, shapes);
  attachConstants(vm, promises);
  attachConstants(vm, fsObj);
  vm.setProp(fsObj, "promises", promises);
  vm.setProp(vm.global, "fs", fsObj);
  attachPath(vm);
  installSandboxFsStubs(vm);
  vm.evalCode(`
    globalThis.require = function require(id) {
      var name = String(id);
      if (name === "fs" || name === "node:fs") return globalThis.fs;
      if (name === "fs/promises" || name === "node:fs/promises") return globalThis.fs.promises;
      if (name === "path" || name === "node:path") return globalThis.path;
      var err = new Error("Sandbox has no Node module loader: " + name);
      err.code = "SANDBOX_NO_MODULE";
      throw err;
    };
  `).dispose();
}
