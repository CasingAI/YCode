// ============================================================
// Sandbox 阶段1测试：活实例、作用域隔离、定时器泵、console 环、
// LocalStorage 配额与落盘灌回（见 docs/specs/sandbox-system-tool.md）
// ============================================================

import assert from "node:assert/strict";
import test from "node:test";
import { createFileSystemError, type FileSystemPort, type SessionId } from "@zcode/contracts";
import { SandboxInstance } from "../src/sandbox/instance.js";
import { SandboxInstanceTable } from "../src/sandbox/instance-table.js";
import {
  SandboxLocalStorage,
  SandboxLocalStorageQuotaError,
} from "../src/sandbox/local-storage.js";
import {
  resolveSandboxLocalStoragePath,
  resolveSessionSandboxDir,
} from "../src/sandbox/constants.js";

const SESSION = "sess_test_sandbox_1" as SessionId;

// 内存版 fileSystemPort：只实现沙盒落盘用到的四个方法。
// 落盘灌回的真相（文件损坏→空世界、缺文件→空世界）用它即可覆盖，
// 不依赖 adapters 的真实文件实现。

class MemoryFileSystem {
  readonly files = new Map<string, string>();

  port(): FileSystemPort {
    return {
      createDirectory: async () => ({ path: "" }) as never,
      readTextFile: async (request) => {
        const content = this.files.get(request.path);
        if (content === undefined) {
          throw createFileSystemError({
            code: "not_found",
            message: "missing",
            path: request.path,
          });
        }
        return { content } as never;
      },
      writeTextFile: async (request) => {
        this.files.set(request.path, request.content);
        return { path: request.path, bytesWritten: request.content.length } as never;
      },
      removeFile: async (request) => {
        // 目录删除：以前缀匹配清掉该目录下全部文件（与 removeFile 语义对齐测试）。
        let removed = false;
        for (const path of [...this.files.keys()]) {
          if (path === request.path || path.startsWith(`${request.path}/`)) {
            this.files.delete(path);
            removed = true;
          }
        }
        return { path: request.path, removed } as never;
      },
    } as unknown as FileSystemPort;
  }
}

function memoryFs(): { fs: MemoryFileSystem; port: FileSystemPort } {
  const fs = new MemoryFileSystem();
  return { fs, port: fs.port() };
}

// -----------------------------------------------
// 两次 eval 共享全局；局部变量不泄漏
// -----------------------------------------------

test("连续两次调用：挂全局可见，局部作用域不可见", async () => {
  const instance = await SandboxInstance.create();
  try {
    const first = await instance.eval(
      "globalThis.shared = 40 + 2; const localOnly = 1; return shared;",
    );
    assert.equal(first.result.kind, "completed");
    if (first.result.kind !== "completed") return;
    assert.equal(first.result.returnText, "42");

    const second = await instance.eval("return shared;");
    assert.equal(second.result.kind, "completed");
    if (second.result.kind !== "completed") return;
    assert.equal(second.result.returnText, "42");

    const third = await instance.eval("return typeof localOnly;");
    assert.equal(third.result.kind, "completed");
    if (third.result.kind !== "completed") return;
    // 原因与修复依据：函数作用域包装让顶层 const 不泄漏，只有挂全局的值跨调用可见。
    assert.equal(third.result.returnText, "undefined");
  } finally {
    instance.dispose();
  }
});

test("return 交回：对象转 JSON 文本，函数标类型仍算成功", async () => {
  const instance = await SandboxInstance.create();
  try {
    const obj = await instance.eval("return ({a:1,b:[2,3]});");
    assert.equal(obj.result.kind, "completed");
    if (obj.result.kind !== "completed") return;
    assert.equal(obj.result.returnText, '{"a":1,"b":[2,3]}');

    const fn = await instance.eval("return (function foo(){});");
    assert.equal(fn.result.kind, "completed");
    if (fn.result.kind !== "completed") return;
    assert.equal(fn.result.returnText, "function");
  } finally {
    instance.dispose();
  }
});

test("语法错与未接住抛错：调用失败，活实例留下", async () => {
  const instance = await SandboxInstance.create();
  try {
    const syntax = await instance.eval("function ( {");
    assert.equal(syntax.result.kind, "failed");
    assert.equal(syntax.alive, true);

    const thrown = await instance.eval('throw new TypeError("boom");');
    assert.equal(thrown.result.kind, "failed");
    if (thrown.result.kind !== "failed") return;
    assert.equal(thrown.result.error.code, "TypeError");
    assert.ok(thrown.result.error.message.includes("boom"));
    assert.equal(thrown.alive, true);

    // 实例留下：之前挂全局的值还在。
    await instance.eval("globalThis.stillHere = 7;");
    const check = await instance.eval("return stillHere;");
    assert.equal(check.result.kind, "completed");
    if (check.result.kind !== "completed") return;
    assert.equal(check.result.returnText, "7");
  } finally {
    instance.dispose();
  }
});

// -----------------------------------------------
// console 环：收集、窗口增量、定时器交错
// -----------------------------------------------

test("console 收集到环：多参数拼接，增量窗口只给新行", async () => {
  const instance = await SandboxInstance.create();
  try {
    const outcome = await instance.eval(
      'console.log("hello", 42); console.warn("caution"); return 1;',
    );
    assert.equal(outcome.result.kind, "completed");
    if (outcome.result.kind !== "completed") return;
    assert.equal(outcome.result.consoleLines.length, 2);
    assert.equal(outcome.result.consoleLines[0].text, "hello 42");
    assert.equal(outcome.result.consoleLines[0].method, "log");
    assert.equal(outcome.result.consoleLines[1].method, "warn");

    // 下一次调用的窗口不带上次的行。
    const next = await instance.eval("return 2;");
    assert.equal(next.result.kind, "completed");
    if (next.result.kind !== "completed") return;
    assert.equal(next.result.consoleLines.length, 0);
  } finally {
    instance.dispose();
  }
});

test("交回后定时器仍触发：host 泵把回调灌回 VM", async () => {
  const instance = await SandboxInstance.create();
  try {
    await instance.eval(
      'globalThis.fired = []; setTimeout(() => { globalThis.fired.push("tick"); }, 10); return "scheduled";',
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const check = await instance.eval("return JSON.stringify(globalThis.fired);");
    assert.equal(check.result.kind, "completed");
    if (check.result.kind !== "completed") return;
    assert.equal(check.result.returnText, '["tick"]');
  } finally {
    instance.dispose();
  }
});

test("定时器回调抛错不杀实例：记一行 console error", async () => {
  const instance = await SandboxInstance.create();
  try {
    await instance.eval('setTimeout(() => { throw new Error("timer boom"); }, 10); return "ok";');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const check = await instance.eval("return 1;");
    assert.equal(check.result.kind, "completed");
    if (check.result.kind !== "completed") return;
    // 原因与修复依据：定时器在两次 eval 之间触发，增量窗口（fromSeq 水位制）自然不含它；
    // 全环里必须有这行，且实例仍可用（这次 eval 成功即证明没被杀）。
    const full = instance.readConsoleWindow({});
    assert.ok(
      full.lines.some((line) => line.method === "error" && line.text.includes("timer boom")),
    );
  } finally {
    instance.dispose();
  }
});

// -----------------------------------------------
// LocalStorage：浏览器形、5MB 配额、落盘灌回
// -----------------------------------------------

test("LocalStorage 浏览器形：set/get/remove/clear/length/key", () => {
  const storage = new SandboxLocalStorage();
  assert.equal(storage.length, 0);
  storage.setItem("a", "1");
  storage.setItem("b", "2");
  assert.equal(storage.length, 2);
  assert.equal(storage.getItem("a"), "1");
  assert.equal(storage.getItem("missing"), null);
  assert.equal(typeof storage.key(0), "string");
  assert.equal(storage.key(99), null);
  storage.removeItem("a");
  assert.equal(storage.length, 1);
  storage.clear();
  assert.equal(storage.length, 0);
});

test("LocalStorage 写爆 5MB：抛配额错，旧数据不动", () => {
  const storage = new SandboxLocalStorage();
  storage.setItem("keep", "me");
  const big = "x".repeat(6 * 1024 * 1024);
  assert.throws(() => storage.setItem("big", big), SandboxLocalStorageQuotaError);
  assert.equal(storage.getItem("keep"), "me");
  assert.equal(storage.getItem("big"), null);
});

test("LocalStorage 同键覆盖先释放旧值：删了重写不再报满", () => {
  const storage = new SandboxLocalStorage();
  const half = "x".repeat(2 * 1024 * 1024);
  storage.setItem("k", half);
  // 同键覆盖：释放旧 2MB 再计新 2MB，不应抛错。
  storage.setItem("k", half);
  assert.equal(storage.getItem("k"), half);
});

test("VM 内 localStorage 端到端：set/get 跨调用可见，超配额抛错", async () => {
  const instance = await SandboxInstance.create();
  try {
    await instance.eval('localStorage.setItem("greet", "hello"); return localStorage.length;');
    const check = await instance.eval('return localStorage.getItem("greet");');
    assert.equal(check.result.kind, "completed");
    if (check.result.kind !== "completed") return;
    assert.equal(check.result.returnText, "hello");

    // 6MB 单值超 5MB 配额：脚本没接住，按普通未接住抛错处理。
    const over = await instance.eval(
      'localStorage.setItem("big", "x".repeat(6*1024*1024)); return "written";',
    );
    assert.equal(over.result.kind, "failed");
    if (over.result.kind !== "failed") return;
    assert.ok(
      over.result.error.message.includes("配额") || over.result.error.code.includes("Quota"),
    );
    // 实例还在，旧数据不动。
    const kept = await instance.eval('return localStorage.getItem("greet");');
    assert.equal(kept.result.kind, "completed");
    if (kept.result.kind !== "completed") return;
    assert.equal(kept.result.returnText, "hello");
  } finally {
    instance.dispose();
  }
});

test("重启后 LocalStorage 还在、全局没了：只从 YCode 落盘路径灌回", async () => {
  const dir = "/memory/.ycode/cli";
  const { fs, port } = memoryFs();
  fs.files.set(
    resolveSandboxLocalStoragePath({
      sandboxStorageRoot: "/memory/.zcode/cli",
      sessionId: String(SESSION),
    }),
    '{"legacy":"must-not-load"}',
  );
  const table = new SandboxInstanceTable({ sandboxStorageRoot: dir, fileSystemPort: port });
  try {
    const legacy = await table.eval({
      sessionId: SESSION,
      code: 'return localStorage.getItem("legacy");',
      timeoutMs: 10_000,
    });
    assert.equal(legacy.result.kind, "completed");
    if (legacy.result.kind !== "completed") return;
    assert.equal(legacy.result.returnText, "null");
    const first = await table.eval({
      sessionId: SESSION,
      code: 'globalThis.heap = "gone"; localStorage.setItem("k", "v"); return 1;',
      timeoutMs: 10_000,
    });
    assert.equal(first.result.kind, "completed");

    // 落盘文件存在。
    const path = resolveSandboxLocalStoragePath({
      sandboxStorageRoot: dir,
      sessionId: String(SESSION),
    });
    const raw = fs.files.get(path) ?? "";
    assert.ok(raw.includes('"k":"v"') || raw.includes('"k": "v"'));

    // 新表 + 同一个内存盘 = 进程重启：全局没了，LocalStorage 灌回。
    const table2 = new SandboxInstanceTable({ sandboxStorageRoot: dir, fileSystemPort: port });
    try {
      const heap = await table2.eval({
        sessionId: SESSION,
        code: "return typeof heap;",
        timeoutMs: 10_000,
      });
      assert.equal(heap.result.kind, "completed");
      if (heap.result.kind !== "completed") return;
      assert.equal(heap.result.returnText, "undefined");

      const ls = await table2.eval({
        sessionId: SESSION,
        code: 'return localStorage.getItem("k");',
        timeoutMs: 10_000,
      });
      assert.equal(ls.result.kind, "completed");
      if (ls.result.kind !== "completed") return;
      assert.equal(ls.result.returnText, "v");
    } finally {
      table2.disposeAll();
    }
  } finally {
    table.disposeAll();
  }
});

test("损坏的 YCode 落盘文件视为空世界，不抛错", async () => {
  const dir = "/memory/.ycode/cli";
  const backing = new MemoryFileSystem();
  const path = resolveSandboxLocalStoragePath({
    sandboxStorageRoot: dir,
    sessionId: String(SESSION),
  });
  backing.files.set(path, "{not json");

  const table = new SandboxInstanceTable({
    sandboxStorageRoot: dir,
    fileSystemPort: backing.port(),
  });
  try {
    const outcome = await table.eval({
      sessionId: SESSION,
      code: "return localStorage.length;",
      timeoutMs: 10_000,
    });
    assert.equal(outcome.result.kind, "completed");
    if (outcome.result.kind !== "completed") return;
    assert.equal(outcome.result.returnText, "0");
  } finally {
    table.disposeAll();
  }
});

// -----------------------------------------------
// 实例表：会话隔离、新实例提示位、dispose
// -----------------------------------------------

test("会话隔离：不同 sessionId 互不可见", async () => {
  const table = new SandboxInstanceTable();
  try {
    await table.eval({
      sessionId: "sess_a" as SessionId,
      code: 'globalThis.secret = "A"; localStorage.setItem("k","A"); return 1;',
      timeoutMs: 10_000,
    });
    const other = await table.eval({
      sessionId: "sess_b" as SessionId,
      code: 'return (typeof secret) + "/" + String(localStorage.getItem("k"));',
      timeoutMs: 10_000,
    });
    assert.equal(other.result.kind, "completed");
    if (other.result.kind !== "completed") return;
    assert.equal(other.result.returnText, "undefined/null");
  } finally {
    table.disposeAll();
  }
});

test("新建实例第一次调用带提示位，只一次", async () => {
  const table = new SandboxInstanceTable();
  try {
    const first = await table.eval({ sessionId: SESSION, code: "return 1;", timeoutMs: 10_000 });
    assert.equal(first.isFirstResultOnNewInstance, true);
    const second = await table.eval({ sessionId: SESSION, code: "return 2;", timeoutMs: 10_000 });
    assert.equal(second.isFirstResultOnNewInstance, false);
  } finally {
    table.disposeAll();
  }
});

test("dispose 后全局没了、LS 已落盘；hasLiveInstance 反映存活", async () => {
  const dir = "/memory/.ycode/cli";
  const { port } = memoryFs();
  const table = new SandboxInstanceTable({ sandboxStorageRoot: dir, fileSystemPort: port });
  try {
    assert.equal(table.hasLiveInstance(SESSION), false);
    await table.eval({
      sessionId: SESSION,
      code: 'globalThis.g = 1; localStorage.setItem("k","v"); return 1;',
      timeoutMs: 10_000,
    });
    assert.equal(table.hasLiveInstance(SESSION), true);
    table.dispose(SESSION);
    assert.equal(table.hasLiveInstance(SESSION), false);

    // dispose 后下次调用是新实例：全局没了、LS 还在、带提示位。
    const next = await table.eval({
      sessionId: SESSION,
      code: 'return (typeof g) + "/" + String(localStorage.getItem("k"));',
      timeoutMs: 10_000,
    });
    assert.equal(next.result.kind, "completed");
    if (next.result.kind !== "completed") return;
    assert.equal(next.result.returnText, "undefined/v");
    assert.equal(next.isFirstResultOnNewInstance, true);
  } finally {
    table.disposeAll();
  }
});

test("落盘路径规则：YCode 根下一会话一目录，固定文件名", () => {
  const dir = resolveSessionSandboxDir({
    sandboxStorageRoot: "/data/.ycode/cli",
    sessionId: "sess_abc",
  });
  assert.equal(dir, "/data/.ycode/cli/sandbox/sess_abc");
  assert.equal(
    resolveSandboxLocalStoragePath({
      sandboxStorageRoot: "/data/.ycode/cli",
      sessionId: "sess_abc",
    }),
    "/data/.ycode/cli/sandbox/sess_abc/local-storage.json",
  );
});

test("超内存分配被引擎硬顶拦下：调用失败，实例留下", async () => {
  const instance = await SandboxInstance.create();
  try {
    // 原因与修复依据：QuickJS memoryLimit=128MB 在分配期抛 InternalError out of memory，
    // 不是事后观测；堆硬顶的事后销毁由实例表承担（见 instance-table.ts）。
    const outcome = await instance.eval(
      'const big = new Array(30_000_000).fill("x".repeat(10)); return "ok";',
    );
    assert.equal(outcome.result.kind, "failed");
    if (outcome.result.kind !== "failed") return;
    assert.ok(
      outcome.result.error.message.includes("memory") ||
        outcome.result.error.code.includes("Internal"),
    );
    assert.equal(outcome.alive, true);
  } finally {
    instance.dispose();
  }
});

test("内联 code 是唯一 eval 来源", async () => {
  const table = new SandboxInstanceTable();
  try {
    const outcome = await table.eval({
      sessionId: SESSION,
      code: "return 6 * 7;",
      timeoutMs: 10_000,
    });
    assert.equal(outcome.result.kind, "completed");
    if (outcome.result.kind !== "completed") return;
    assert.equal(outcome.result.returnText, "42");
  } finally {
    table.disposeAll();
  }
});
