// ============================================================
// Worker 内 fs 的同步实现（*Sync）
// ============================================================
// 真正做 IO 的是主线程：同步方法经 `host.callSync` 发 host-call 并阻塞在
// SharedArrayBuffer 上，主线程用现有异步 FileSystemPort 执行后写回并唤醒。
// 本文件只负责：参数读取、把可序列化结果还原成 guest 值、在 guest 里抛错。
//
// 错误必须在 guest 世界里构造（保留 err.code / err.name）：宿主函数抛出的
// Error 经 quickjs-wasi 转换后会丢 code，所以宿主函数返回
// `{ok,value|error,token}`，由 guest 包装器读取后自行 throw。
// 每个结果对象在读取后调用 `__sandboxSyncRelease` 释放宿主引用，避免大文件
// 读取的 Uint8Array 在 VM 里长期重复持有。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import { sandboxHostErrorInfo } from "./host-args.js";
import type { HostArg } from "./host-args.js";
import { snapshotHostArg } from "./fs-host-bridge.js";
import type { SandboxHostCaller, SandboxHostOperation } from "./worker-protocol.js";

/**
 * quickjs-wasi 的 `hostToHandle` 在递归填充对象/数组后会 dispose 每个子值的
 * handle，包括 `true` / `false` / `null` / `undefined` 这几个缓存单例。缓存
 * handle 被释放后，后续同样值会返回悬垂指针（实测表现为布尔字段变成
 * 次正规数），所以这里自己做一层转换：缓存单例只引用、不释放。
 */
function isCachedSingleton(vm: QuickJS, handle: JSValueHandle): boolean {
  return handle === vm.undefined || handle === vm.null || handle === vm.true || handle === vm.false;
}

function toGuestValue(vm: QuickJS, value: unknown): JSValueHandle {
  if (value instanceof Uint8Array) return vm.newUint8Array(value);
  if (Array.isArray(value)) {
    const array = vm.newArray();
    for (let index = 0; index < value.length; index += 1) {
      const child = toGuestValue(vm, value[index]);
      array.setProp(String(index), child);
      if (!isCachedSingleton(vm, child)) child.dispose();
    }
    return array;
  }
  if (value !== null && typeof value === "object") {
    const object = vm.newObject();
    for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
      const child = toGuestValue(vm, childValue);
      object.setProp(key, child);
      if (!isCachedSingleton(vm, child)) child.dispose();
    }
    return object;
  }
  // 原始值（含缓存单例）交给库创建；调用方按 isCachedSingleton 决定是否释放。
  return vm.hostToHandle(value);
}

const SYNC_FS_SCRIPT = String.raw`
(function () {
  var callHost = globalThis.__sandboxSyncHostCall;
  var release = globalThis.__sandboxSyncRelease;
  var makeStats = globalThis.__sandboxMakeStats;
  var makeDirent = globalThis.__sandboxMakeDirent;

  function fail(code, message) {
    var err = new Error(message);
    err.code = code;
    throw err;
  }

  function call(op, args) {
    var outcome = callHost(op, args[0], args[1], args[2]);
    var token = outcome.token;
    var ok = outcome.ok;
    var value = outcome.value;
    var error = outcome.error;
    try {
      release(token);
    } catch (releaseError) {
      // 释放失败不掩盖本次调用结果。
    }
    if (!ok) {
      var err = new Error(error && error.message ? error.message : "Sandbox synchronous filesystem call failed");
      err.code = error && error.code ? error.code : "SANDBOX_FS_SYNC_BRIDGE";
      if (error && error.name) err.name = error.name;
      throw err;
    }
    return value;
  }

  function assertStatOptions(name, options) {
    if (!options || typeof options !== "object") return;
    if (options.bigint === true) {
      fail("EINVAL", name + " does not support { bigint: true } in the sandbox; use the default number options.");
    }
    if (options.throwIfNoEntry === false) {
      fail("EINVAL", name + " does not support { throwIfNoEntry: false } in the sandbox; catch ENOENT instead.");
    }
  }

  function entriesOf(result) {
    return result && result.entries ? result.entries : [];
  }

  fs.readFileSync = function (path, options) {
    return call("fs.readFile", [path, options]);
  };

  fs.writeFileSync = function (path, data, options) {
    call("fs.writeFile", [path, data, options]);
  };

  fs.appendFileSync = function (path, data, options) {
    call("fs.appendFile", [path, data, options]);
  };

  fs.readdirSync = function (path, options) {
    if (options && typeof options === "object" && options.recursive === true) {
      fail("SANDBOX_FS_UNSUPPORTED", "readdirSync does not support { recursive: true } in the sandbox; call readdirSync on each directory.");
    }
    var entries = entriesOf(call("fs.readdir", [path, options]));
    var withTypes = !!(options && typeof options === "object" && options.withFileTypes);
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      out.push(withTypes ? makeDirent(entries[i].name, entries[i].kind) : entries[i].name);
    }
    return out;
  };

  fs.statSync = function (path, options) {
    assertStatOptions("statSync", options);
    var info = call("fs.stat", [path]);
    return makeStats(info.kind, info.sizeBytes, info.mtimeMs);
  };

  fs.lstatSync = function (path, options) {
    assertStatOptions("lstatSync", options);
    var info = call("fs.lstat", [path]);
    return makeStats(info.kind, info.sizeBytes, info.mtimeMs);
  };

  fs.accessSync = function (path, mode) {
    call("fs.access", [path, mode]);
  };

  fs.mkdirSync = function (path, options) {
    call("fs.mkdir", [path, options]);
  };

  fs.unlinkSync = function (path) {
    call("fs.unlink", [path]);
  };

  fs.rmdirSync = function (path, options) {
    if (options && typeof options === "object" && options.recursive === true) {
      fail("SANDBOX_FS_UNSUPPORTED", "rmdirSync does not support { recursive: true } in the sandbox; use rmSync({ recursive: true }).");
    }
    call("fs.rmdir", [path]);
  };

  fs.rmSync = function (path, options) {
    call("fs.rm", [path, options]);
  };

  fs.renameSync = function (oldPath, newPath) {
    call("fs.rename", [oldPath, newPath]);
  };

  fs.copyFileSync = function (src, dest, mode) {
    call("fs.copyFile", [src, dest, mode]);
  };

  fs.existsSync = function (path) {
    try {
      call("fs.stat", [path]);
      return true;
    } catch (error) {
      return false;
    }
  };

  fs.realpathSync = function (path, options) {
    return call("fs.realpath", [path, options]);
  };
  fs.realpathSync.native = function () {
    fail("SANDBOX_FS_UNSUPPORTED", "realpathSync.native is not implemented in the sandbox; use realpathSync (FileSystemPort.realpath).");
  };
})();
`;

export function installSandboxFsSync(vm: QuickJS, host: SandboxHostCaller): void {
  // 同步结果对象在 guest 读取完字段后显式释放宿主引用（大文件正文不长期重复持有）。
  const pendingResults = new Map<number, JSValueHandle>();
  let nextToken = 1;

  using callFn = vm.newFunction("__sandboxSyncHostCall", (...handles) => {
    const [opHandle, ...argHandles] = handles;
    const op = opHandle ? opHandle.toString() : "";
    let value: unknown;
    let args: HostArg[];
    try {
      args = argHandles.map((arg) => snapshotHostArg(vm, arg));
    } catch (error) {
      return toGuestValue(vm, { ok: false, error: sandboxHostErrorInfo(error), token: 0 });
    }
    try {
      value = host.callSync(op as SandboxHostOperation, args);
    } catch (error) {
      return toGuestValue(vm, { ok: false, error: sandboxHostErrorInfo(error), token: 0 });
    }
    // 成功后保留宿主引用，guest 读取完字段会调用 __sandboxSyncRelease(token)。
    const token = nextToken++;
    const handle = toGuestValue(vm, { ok: true, value, token });
    pendingResults.set(token, handle);
    return handle;
  });

  using releaseFn = vm.newFunction("__sandboxSyncRelease", (tokenHandle) => {
    const token = tokenHandle ? tokenHandle.toNumber() : 0;
    const handle = pendingResults.get(token);
    if (handle) {
      pendingResults.delete(token);
      try {
        handle.dispose();
      } catch {
        // 释放幂等。
      }
    }
    return vm.undefined;
  });

  vm.setProp(vm.global, "__sandboxSyncHostCall", callFn);
  vm.setProp(vm.global, "__sandboxSyncRelease", releaseFn);
  vm.evalCode(SYNC_FS_SCRIPT).dispose();
  vm.evalCode(
    "delete globalThis.__sandboxSyncHostCall; delete globalThis.__sandboxSyncRelease; " +
      "delete globalThis.__sandboxMakeStats; delete globalThis.__sandboxMakeDirent;",
  ).dispose();
}
