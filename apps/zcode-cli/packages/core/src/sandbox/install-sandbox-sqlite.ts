// 往活实例安装只读 SQLite 查询面：`require("node:sqlite")` 的 `{ query, tables }`。
// 真做走 SqliteReadPort（worker 线程），guest 里没有 SQLite 引擎。
// 路径与 Read 等工具同一解析（path-policy 的 resolveWorkspacePath），不拦工作区外。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import type { SqliteReadRow } from "@zcode/contracts";
import { resolveWorkspacePath } from "../tool/path-policy.js";
import { SANDBOX_SQLITE_QUERY_TIMEOUT_MS } from "./constants.js";
import { hostAsyncFunction, hostArgString, type HostArg } from "./fs-host-bridge.js";
import type { SandboxFsCallContext } from "./fs-host-context.js";
import { registerSandboxRequireModule } from "./install-sandbox-require.js";
import {
  fromSqlitePortOrUnknown,
  SandboxSqliteError,
  sandboxSqliteNoHostError,
} from "./sqlite-errors.js";
import type { SandboxSqliteHostLookup } from "./sqlite-host-context.js";

export type {
  SandboxSqliteCallContext,
  SandboxSqliteHostLookup,
  SandboxInstanceSqliteHost,
  SandboxSqliteHostPaths,
} from "./sqlite-host-context.js";

function requireSqliteHost(lookup: SandboxSqliteHostLookup) {
  const ctx = lookup();
  if (!ctx) throw sandboxSqliteNoHostError();
  return ctx;
}

async function jailDbPath(
  ctx: {
    workingDirectory: string;
    workspaceRoot: string;
  },
  target: string,
): Promise<string> {
  // 与 FS 同一边界：不拦工作区外路径，只拒绝空路径。
  return resolveWorkspacePath({
    inputPath: target.trim(),
    workingDirectory: ctx.workingDirectory,
    workspaceRoot: ctx.workspaceRoot,
    operation: "read",
  });
}

function hostParams(args: HostArg[], index: number): readonly unknown[] | undefined {
  const arg = args[index];
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return undefined;
  if (arg.kind === "array") return arg.value;
  throw new SandboxSqliteError("EINVAL", "params must be an array");
}

function toGuestValue(vm: QuickJS, value: unknown): JSValueHandle {
  if (value === null || value === undefined) return vm.null;
  if (typeof value === "string") return vm.newString(value);
  if (typeof value === "number") return vm.newNumber(value);
  if (typeof value === "boolean") return vm.newNumber(value ? 1 : 0);
  if (value instanceof Uint8Array) return vm.newUint8Array(value);
  // bigint 不应出现（worker 边界已归一）；其余走字符串兜底。
  return vm.newString(typeof value === "bigint" ? value.toString() : String(value));
}

function toGuestRow(vm: QuickJS, row: SqliteReadRow): JSValueHandle {
  const obj = vm.newObject();
  for (const [key, value] of Object.entries(row)) {
    const handle = toGuestValue(vm, value);
    obj.setProp(key, handle);
    handle.dispose();
  }
  return obj;
}

function toGuestRows(vm: QuickJS, rows: SqliteReadRow[]): JSValueHandle {
  const arr = vm.newArray();
  for (let index = 0; index < rows.length; index++) {
    const item = toGuestRow(vm, rows[index]!);
    arr.setProp(String(index), item);
    item.dispose();
  }
  using length = vm.newNumber(rows.length);
  arr.setProp("length", length);
  return arr;
}

function toGuestStrings(vm: QuickJS, values: string[]): JSValueHandle {
  const arr = vm.newArray();
  for (let index = 0; index < values.length; index++) {
    using item = vm.newString(values[index]!);
    arr.setProp(String(index), item);
  }
  using length = vm.newNumber(values.length);
  arr.setProp("length", length);
  return arr;
}

export function installSandboxSqlite(
  vm: QuickJS,
  lookup: SandboxSqliteHostLookup,
  fsLookup: () => SandboxFsCallContext | undefined,
): void {
  using queryFn = hostAsyncFunction(vm, "sqlite.query", async (args) => {
    try {
      const ctx = requireSqliteHost(lookup);
      const fsCtx = fsLookup();
      if (!fsCtx) throw sandboxSqliteNoHostError();
      const dbPath = await jailDbPath(fsCtx, hostArgString(args[0], "dbPath"));
      const sql = hostArgString(args[1], "sql");
      const params = hostParams(args, 2);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SANDBOX_SQLITE_QUERY_TIMEOUT_MS);
      try {
        const result = await ctx.sqliteReadPort.query({
          dbPath,
          sql,
          params,
          signal: controller.signal,
        });
        return toGuestRows(vm, result.rows);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      throw fromSqlitePortOrUnknown(error);
    }
  });
  vm.setProp(vm.global, "__sandboxSqliteQuery", queryFn);

  using tablesFn = hostAsyncFunction(vm, "sqlite.tables", async (args) => {
    try {
      const ctx = requireSqliteHost(lookup);
      const fsCtx = fsLookup();
      if (!fsCtx) throw sandboxSqliteNoHostError();
      const dbPath = await jailDbPath(fsCtx, hostArgString(args[0], "dbPath"));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SANDBOX_SQLITE_QUERY_TIMEOUT_MS);
      try {
        const result = await ctx.sqliteReadPort.listTables({
          dbPath,
          signal: controller.signal,
        });
        return toGuestStrings(vm, result.tables);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      throw fromSqlitePortOrUnknown(error);
    }
  });
  vm.setProp(vm.global, "__sandboxSqliteTables", tablesFn);

  vm.evalCode(SQLITE_GUEST_BOOTSTRAP).dispose();
  using sqliteApi = vm.global.getProp("__sandboxSqlite");
  registerSandboxRequireModule(vm, "sqlite", sqliteApi);
  registerSandboxRequireModule(vm, "node:sqlite", sqliteApi);
}

const SQLITE_GUEST_BOOTSTRAP = `
(function () {
  var api = {
    query: function (dbPath, sql, params) {
      return __sandboxSqliteQuery(String(dbPath), String(sql), params);
    },
    tables: function (dbPath) {
      return __sandboxSqliteTables(String(dbPath));
    },
  };
  globalThis.__sandboxSqlite = api;
})();
`;
