// Stats / Dirent：方法必须在 guest 世界里，hostToHandle 会丢掉函数。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import type { FileSystemNodeKind } from "@zcode/contracts";

export interface SandboxFsShapes {
  makeStats(kind: FileSystemNodeKind, size: number, mtimeMs: number): JSValueHandle;
  makeDirent(name: string, kind: FileSystemNodeKind): JSValueHandle;
}

export function installSandboxFsShapes(vm: QuickJS): SandboxFsShapes {
  vm.evalCode(`
    globalThis.__sandboxMakeStats = function (kind, size, mtimeMs) {
      return {
        size: size,
        mtimeMs: mtimeMs,
        isFile: function () { return kind === "file"; },
        isDirectory: function () { return kind === "directory"; },
        isSymbolicLink: function () { return kind === "symlink"; },
      };
    };
    globalThis.__sandboxMakeDirent = function (name, kind) {
      return {
        name: name,
        isFile: function () { return kind === "file"; },
        isDirectory: function () { return kind === "directory"; },
        isSymbolicLink: function () { return kind === "symlink"; },
      };
    };
  `).dispose();
  const makeStatsFn = vm.global.getProp("__sandboxMakeStats");
  const makeDirentFn = vm.global.getProp("__sandboxMakeDirent");
  // 同步适配器安装完会一起删除这两个内部全局；这里保留是为了让
  // fs-sync-implemented.ts 的 guest 包装器能先捕获函数引用。
  return {
    makeStats(kind, size, mtimeMs) {
      using kindHandle = vm.newString(kind);
      using sizeHandle = vm.newNumber(size);
      using mtimeHandle = vm.newNumber(mtimeMs);
      return vm.callFunction(makeStatsFn, vm.undefined, kindHandle, sizeHandle, mtimeHandle);
    },
    makeDirent(name, kind) {
      using nameHandle = vm.newString(name);
      using kindHandle = vm.newString(kind);
      return vm.callFunction(makeDirentFn, vm.undefined, nameHandle, kindHandle);
    },
  };
}
