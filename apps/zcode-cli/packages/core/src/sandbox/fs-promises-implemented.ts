// ============================================================
// Worker 内 fs.promises guest 适配层
// ============================================================
// 真正做 IO 的是主线程（按 sessionId 现读 FileSystemPort / mode / cwd）。
// 本文件只负责：参数读取、把主线程交回的可序列化结果还原成 guest 句柄。
// Node 形 Stats / Dirent 必须在 guest 世界里创建（hostToHandle 会丢函数）。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import {
  hostArgBytesOrString,
  hostArgFlag,
  hostArgString,
  type HostArg,
} from "./host-args.js";
import { hostAsyncFunction } from "./fs-host-bridge.js";
import { SANDBOX_FS_PROMISE_IMPLEMENTED } from "./fs-names.js";
import type { SandboxFsShapes } from "./fs-node-shapes.js";
import type {
  SandboxFsReadFileResult,
  SandboxFsReaddirResult,
  SandboxFsStatResult,
  SandboxHostCaller,
} from "./worker-protocol.js";

type PromiseOperation = (args: HostArg[]) => Promise<JSValueHandle>;

export function attachImplementedPromises(
  vm: QuickJS,
  promises: JSValueHandle,
  host: SandboxHostCaller,
  shapes: SandboxFsShapes,
): Record<(typeof SANDBOX_FS_PROMISE_IMPLEMENTED)[number], PromiseOperation> {
  const impl: Record<(typeof SANDBOX_FS_PROMISE_IMPLEMENTED)[number], PromiseOperation> = {
    async readFile(args) {
      const result = (await host.call("fs.readFile", args)) as SandboxFsReadFileResult;
      if (result.kind === "string") return vm.newString(result.value as string);
      return vm.newUint8Array(result.value as Uint8Array);
    },
    async writeFile(args) {
      await host.call("fs.writeFile", normalizeWriteArgs(args, "writeFile"));
      return vm.undefined;
    },
    async appendFile(args) {
      await host.call("fs.appendFile", normalizeWriteArgs(args, "appendFile"));
      return vm.undefined;
    },
    async readdir(args) {
      const result = (await host.call("fs.readdir", args)) as SandboxFsReaddirResult;
      const arr = vm.newArray();
      const withFileTypes = hostArgFlag(args[1], "withFileTypes");
      for (let index = 0; index < result.entries.length; index++) {
        const entry = result.entries[index]!;
        const item = withFileTypes
          ? shapes.makeDirent(entry.name, entry.kind)
          : vm.newString(entry.name);
        arr.setProp(String(index), item);
        item.dispose();
      }
      using length = vm.newNumber(result.entries.length);
      arr.setProp("length", length);
      return arr;
    },
    async stat(args) {
      const result = (await host.call("fs.stat", args)) as SandboxFsStatResult;
      return shapes.makeStats(result.kind, result.sizeBytes, result.mtimeMs);
    },
    async lstat(args) {
      const result = (await host.call("fs.lstat", args)) as SandboxFsStatResult;
      return shapes.makeStats(result.kind, result.sizeBytes, result.mtimeMs);
    },
    async access(args) {
      await host.call("fs.access", args);
      return vm.undefined;
    },
    async mkdir(args) {
      await host.call("fs.mkdir", args);
      return vm.undefined;
    },
    async unlink(args) {
      await host.call("fs.unlink", args);
      return vm.undefined;
    },
    async rmdir(args) {
      await host.call("fs.rmdir", args);
      return vm.undefined;
    },
    async rm(args) {
      await host.call("fs.rm", args);
      return vm.undefined;
    },
    async rename(args) {
      await host.call("fs.rename", args);
      return vm.undefined;
    },
    async copyFile(args) {
      await host.call("fs.copyFile", args);
      return vm.undefined;
    },
  };

  for (const name of SANDBOX_FS_PROMISE_IMPLEMENTED) {
    using fn = hostAsyncFunction(vm, `fs.promises.${name}`, impl[name]);
    vm.setProp(promises, name, fn);
  }
  return impl;
}

/**
 * 写类参数先由 guest 侧做形状校验，错误码与 Promise 语义一致（EINVAL）。
 * 路径解析、模式检查与端口调用仍在主线程，不能在这里越权。
 */
function normalizeWriteArgs(args: HostArg[], _label: string): HostArg[] {
  const path = hostArgString(args[0], "path");
  hostArgBytesOrString(args[1], "data");
  return [
    { kind: "string", value: path },
    args[1] ?? { kind: "undefined" },
  ];
}
