// 沙盒受限 require 注册表：各能力各自登记 module id，共用同一段 require 注入。
// 未登记的 id 交 SANDBOX_NO_MODULE，不得把引擎的缺模块原文交回。
// import / import() 经 rewrite 改写成 require 后落到同一注册表。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";

const REQUIRE_REGISTRY_PROP = "__sandboxRequireModules";

export function installSandboxRequire(vm: QuickJS): void {
  vm.evalCode(`
    globalThis.${REQUIRE_REGISTRY_PROP} = {};
    globalThis.require = function require(id) {
      var name = String(id);
      var resolved = globalThis.${REQUIRE_REGISTRY_PROP}[name];
      if (resolved === undefined) {
        var err = new Error("Sandbox has no Node module loader: " + name);
        err.code = "SANDBOX_NO_MODULE";
        throw err;
      }
      return resolved;
    };
  `).dispose();
}

export function registerSandboxRequireModule(vm: QuickJS, id: string, value: JSValueHandle): void {
  using registry = vm.global.getProp(REQUIRE_REGISTRY_PROP);
  registry.setProp(id, value);
}
