// fs.promises 真做 1–18：路径与 Read 等工具共用 path-policy 的 resolveWorkspacePath，
// 不拦工作区外路径（见 path-policy.ts 与 docs/specs/sandbox-system-tool.md「路径边界」）。
// 只读档在写方法入口拒绝（先于路径解析，保持档位错误优先）。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import { resolveWorkspacePath } from "../tool/path-policy.js";
import { SANDBOX_FS_READ_MAX_BYTES } from "./constants.js";
import { sandboxReadonlyError } from "./fs-errors.js";
import {
  hostArgBytesOrString,
  hostArgEncoding,
  hostArgFlag,
  hostArgString,
  hostAsyncFunction,
  isUtf8Encoding,
  requireFsHost,
  type HostArg,
} from "./fs-host-bridge.js";
import type { SandboxFsCallContext, SandboxFsHostLookup } from "./fs-host-context.js";
import { SANDBOX_FS_PROMISE_IMPLEMENTED } from "./fs-names.js";
import type { SandboxFsShapes } from "./fs-node-shapes.js";

function assertWritable(ctx: SandboxFsCallContext, method: string): void {
  if (ctx.mode === "plan" || ctx.mode === "readonly") throw sandboxReadonlyError(method);
}

// 路径与 Read 等工具同一解析：相对会话 cwd，空路径拒绝，不做工作区包含性检查。
function jail(ctx: SandboxFsCallContext, target: string, operation: "read" | "write"): string {
  return resolveWorkspacePath({
    inputPath: target.trim(),
    workingDirectory: ctx.workingDirectory,
    workspaceRoot: ctx.workspaceRoot,
    operation,
  });
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

export function attachImplementedPromises(
  vm: QuickJS,
  promises: JSValueHandle,
  lookup: SandboxFsHostLookup,
  shapes: SandboxFsShapes,
): void {
  const impl: Record<(typeof SANDBOX_FS_PROMISE_IMPLEMENTED)[number], (args: HostArg[]) => Promise<JSValueHandle>> = {
    async readFile(args) {
      const ctx = requireFsHost(lookup);
      const path = jail(ctx, hostArgString(args[0], "path"), "read");
      const result = await ctx.fileSystemPort.readBinaryFile({
        path,
        maxBytes: SANDBOX_FS_READ_MAX_BYTES,
      });
      if (isUtf8Encoding(hostArgEncoding(args[1]))) {
        return vm.newString(new TextDecoder("utf8").decode(result.content));
      }
      return vm.newUint8Array(result.content);
    },
    async writeFile(args) {
      const ctx = requireFsHost(lookup);
      assertWritable(ctx, "writeFile");
      const path = jail(ctx, hostArgString(args[0], "path"), "write");
      await ctx.fileSystemPort.writeBinaryFile({
        path,
        content: toBytes(hostArgBytesOrString(args[1], "data")),
        createParents: false,
      });
      return vm.undefined;
    },
    async appendFile(args) {
      const ctx = requireFsHost(lookup);
      assertWritable(ctx, "appendFile");
      const path = jail(ctx, hostArgString(args[0], "path"), "write");
      await ctx.fileSystemPort.appendFile({
        path,
        content: hostArgBytesOrString(args[1], "data"),
      });
      return vm.undefined;
    },
    async readdir(args) {
      const ctx = requireFsHost(lookup);
      const path = jail(ctx, hostArgString(args[0], "path"), "read");
      const listed = await ctx.fileSystemPort.listDirectory({ path });
      const arr = vm.newArray();
      const withFileTypes = hostArgFlag(args[1], "withFileTypes");
      for (let index = 0; index < listed.entries.length; index++) {
        const entry = listed.entries[index];
        const item = withFileTypes
          ? shapes.makeDirent(entry.name, entry.kind)
          : vm.newString(entry.name);
        arr.setProp(String(index), item);
        item.dispose();
      }
      using length = vm.newNumber(listed.entries.length);
      arr.setProp("length", length);
      return arr;
    },
    async stat(args) {
      const ctx = requireFsHost(lookup);
      const path = jail(ctx, hostArgString(args[0], "path"), "read");
      const info = await ctx.fileSystemPort.stat({ path });
      return shapes.makeStats(info.kind, info.sizeBytes, info.mtimeMs ?? 0);
    },
    async lstat(args) {
      const ctx = requireFsHost(lookup);
      const path = jail(ctx, hostArgString(args[0], "path"), "read");
      const info = await ctx.fileSystemPort.lstat({ path });
      return shapes.makeStats(info.kind, info.sizeBytes, info.mtimeMs ?? 0);
    },
    async access(args) {
      const ctx = requireFsHost(lookup);
      const path = jail(ctx, hostArgString(args[0], "path"), "read");
      await ctx.fileSystemPort.stat({ path });
      return vm.undefined;
    },
    async mkdir(args) {
      const ctx = requireFsHost(lookup);
      assertWritable(ctx, "mkdir");
      const path = jail(ctx, hostArgString(args[0], "path"), "write");
      await ctx.fileSystemPort.createDirectory({
        path,
        recursive: hostArgFlag(args[1], "recursive"),
      });
      return vm.undefined;
    },
    async unlink(args) {
      const ctx = requireFsHost(lookup);
      assertWritable(ctx, "unlink");
      const path = jail(ctx, hostArgString(args[0], "path"), "write");
      await ctx.fileSystemPort.removeFile({ path });
      return vm.undefined;
    },
    async rmdir(args) {
      const ctx = requireFsHost(lookup);
      assertWritable(ctx, "rmdir");
      const path = jail(ctx, hostArgString(args[0], "path"), "write");
      await ctx.fileSystemPort.removeDirectory({ path });
      return vm.undefined;
    },
    async rm(args) {
      const ctx = requireFsHost(lookup);
      assertWritable(ctx, "rm");
      const path = jail(ctx, hostArgString(args[0], "path"), "write");
      const recursive = hostArgFlag(args[1], "recursive");
      const force = hostArgFlag(args[1], "force");
      await ctx.fileSystemPort.remove({ path, recursive, force, missingOk: force });
      return vm.undefined;
    },
    async rename(args) {
      const ctx = requireFsHost(lookup);
      assertWritable(ctx, "rename");
      const fromPath = jail(ctx, hostArgString(args[0], "oldPath"), "write");
      const toPath = jail(ctx, hostArgString(args[1], "newPath"), "write");
      await ctx.fileSystemPort.rename({ fromPath, toPath });
      return vm.undefined;
    },
    async copyFile(args) {
      const ctx = requireFsHost(lookup);
      assertWritable(ctx, "copyFile");
      const fromPath = jail(ctx, hostArgString(args[0], "src"), "write");
      const toPath = jail(ctx, hostArgString(args[1], "dest"), "write");
      await ctx.fileSystemPort.copyFile({ fromPath, toPath });
      return vm.undefined;
    },
  };

  for (const name of SANDBOX_FS_PROMISE_IMPLEMENTED) {
    using fn = hostAsyncFunction(vm, `fs.promises.${name}`, impl[name]);
    vm.setProp(promises, name, fn);
  }
}
