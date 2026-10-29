// 往 Worker 内活实例安装只读 SQLite 查询面：`require("node:sqlite")` 的 `{ query, tables }`。
// 真做在主线程（按 sessionId 现读 SqliteReadPort / FileSystemPort）；guest 里没有
// SQLite 引擎。路径解析、只读强制与超时都在主线程，Worker 只还原 guest 形状。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import { hostAsyncFunction, type HostArg } from "./fs-host-bridge.js";
import { registerSandboxRequireModule } from "./install-sandbox-require.js";
import { SandboxHostError } from "./host-args.js";
import type {
  SandboxHostCaller,
  SandboxSqliteQueryResult,
  SandboxSqliteTablesResult,
} from "./worker-protocol.js";

function toGuestValue(vm: QuickJS, value: unknown): JSValueHandle {
  if (value === null || value === undefined) return vm.null;
  if (typeof value === "string") return vm.newString(value);
  if (typeof value === "number") return vm.newNumber(value);
  if (typeof value === "boolean") return vm.newNumber(value ? 1 : 0);
  if (value instanceof Uint8Array) return vm.newUint8Array(value);
  // bigint 不应出现（主线程边界已归一）；其余走字符串兜底。
  return vm.newString(typeof value === "bigint" ? value.toString() : String(value));
}

function toGuestRow(vm: QuickJS, row: Record<string, unknown>): JSValueHandle {
  const obj = vm.newObject();
  for (const [key, value] of Object.entries(row)) {
    const handle = toGuestValue(vm, value);
    obj.setProp(key, handle);
    handle.dispose();
  }
  return obj;
}

function toGuestRows(vm: QuickJS, rows: Array<Record<string, unknown>>): JSValueHandle {
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

function hostParams(args: HostArg[], index: number): unknown[] | undefined {
  const arg = args[index];
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return undefined;
  if (arg.kind === "array") return arg.value;
  throw new SandboxHostError("EINVAL", "params must be an array");
}

export function installSandboxSqlite(vm: QuickJS, host: SandboxHostCaller): void {
  using queryFn = hostAsyncFunction(vm, "sqlite.query", async (args) => {
    const result = (await host.call("sqlite.query", [
      args[0] ?? { kind: "undefined" },
      args[1] ?? { kind: "undefined" },
      { kind: "array", value: hostParams(args, 2) ?? [] },
    ])) as SandboxSqliteQueryResult;
    return toGuestRows(vm, result.rows);
  });
  vm.setProp(vm.global, "__sandboxSqliteQuery", queryFn);

  using tablesFn = hostAsyncFunction(vm, "sqlite.tables", async (args) => {
    const result = (await host.call("sqlite.tables", [
      args[0] ?? { kind: "undefined" },
    ])) as SandboxSqliteTablesResult;
    return toGuestStrings(vm, result.tables);
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
