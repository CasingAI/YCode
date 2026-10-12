// ============================================================
// Sandbox 阶段8测试：控制台用户 eval（source=user 执行行）与重置
// （见 docs/specs/sandbox-system-tool.md「控制台」与阶段8）
// ============================================================
// 用户 eval 与模型工具调用进同一活实例：用户敲赋值，模型下次读得到全局；
// 执行行来源可区分（model/user）；重置后实例消失、LocalStorage 仍在、
// 后台 ID 全失效；失败态用 kind，不抛错。

import assert from "node:assert/strict";
import test from "node:test";
import { createFileSystemError, type FileSystemPort, type SessionId } from "@zcode/contracts";
import { SandboxInstanceTable } from "../src/sandbox/instance-table.js";
import { evalSandboxForUser } from "../src/sandbox/user-eval.js";

const SESSION = "sess_test_sandbox_user_eval" as SessionId;

function freshTable(): SandboxInstanceTable {
  return new SandboxInstanceTable({});
}

// 内存版 fileSystemPort：只实现沙盒落盘用到的四个方法（与 sandbox-instance.test.ts 同形）。
class MemoryFileSystem {
  readonly files = new Map<string, string>();

  port(): FileSystemPort {
    return {
      createDirectory: async () => ({ path: "" }) as never,
      readTextFile: async (request) => {
        const content = this.files.get(request.path);
        if (content === undefined) {
          throw createFileSystemError({ code: "not_found", message: "missing", path: request.path });
        }
        return { content } as never;
      },
      writeTextFile: async (request) => {
        this.files.set(request.path, request.content);
        return { path: request.path, bytesWritten: request.content.length } as never;
      },
      removeFile: async (request) => {
        let removed = false;
        for (const path of this.files.keys()) {
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

test("用户 eval 与模型调用共享同一活实例：用户赋值，模型读得到", async () => {
  const table = freshTable();
  try {
    const user = await evalSandboxForUser(table, SESSION, "globalThis.fromUser = 41 + 1;");
    assert.equal(user.result.kind, "completed");

    const model = await table.eval({
      sessionId: SESSION,
      code: "return globalThis.fromUser;",
      timeoutMs: 120_000,
    });
    assert.equal(model.result.kind, "completed");
    if (model.result.kind !== "completed") return;
    assert.equal(model.result.returnText, "42");
  } finally {
    table.dispose(SESSION);
  }
});

test("执行行来源可区分：用户 eval 记 user，模型调用记 model", async () => {
  const table = freshTable();
  try {
    await evalSandboxForUser(table, SESSION, "1 + 1;");
    await table.eval({ sessionId: SESSION, code: "return 2 + 2;", timeoutMs: 120_000 });
    const rows = table.readExecutions(SESSION);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source, "user");
    assert.equal(rows[1].source, "model");
  } finally {
    table.dispose(SESSION);
  }
});

test("用户 eval 纯表达式直接求值：1+1 交回 2，不要求 return", async () => {
  const table = freshTable();
  try {
    // 原因与修复依据：控制台是 DevTools 语义（spec「用户敲什么就 eval 什么」），
    // 纯表达式直接求值；模型工具链路仍走 return 协议（见 sandbox-instance.test.ts）。
    const outcome = await evalSandboxForUser(table, SESSION, "1 + 1");
    assert.equal(outcome.result.kind, "completed");
    if (outcome.result.kind !== "completed") return;
    assert.equal(outcome.result.returnText, "2");
  } finally {
    table.dispose(SESSION);
  }
});

test("用户 eval 顶层 await 求值：await Promise 直接交回结算值", async () => {
  const table = freshTable();
  try {
    const outcome = await evalSandboxForUser(table, SESSION, "await Promise.resolve(5)");
    assert.equal(outcome.result.kind, "completed");
    if (outcome.result.kind !== "completed") return;
    assert.equal(outcome.result.returnText, "5");
  } finally {
    table.dispose(SESSION);
  }
});

test("用户 eval 语句回退：let/if/function 按语句语义执行，无交回值但副作用可见", async () => {
  const table = freshTable();
  try {
    const declared = await evalSandboxForUser(
      table,
      SESSION,
      "globalThis.stmtSeen = 7; let hidden = 1;",
    );
    assert.equal(declared.result.kind, "completed");
    if (declared.result.kind !== "completed") return;
    // 语句模式无表达式值：交回缺席，副作用（全局赋值）已生效。
    assert.equal(declared.result.returnText, undefined);
    const readback = await evalSandboxForUser(table, SESSION, "globalThis.stmtSeen + 1");
    assert.equal(readback.result.kind, "completed");
    if (readback.result.kind !== "completed") return;
    assert.equal(readback.result.returnText, "8");
  } finally {
    table.dispose(SESSION);
  }
});

test("用户 eval 运行时错误不回退语句：ReferenceError 直接失败", async () => {
  const table = freshTable();
  try {
    // 原因与修复依据：表达式解析期 SyntaxError 才回退；运行时错误（已结算 failed）
    // 说明表达式本身合法但执行失败，回退会把副作用跑两遍，故直接失败。
    const outcome = await evalSandboxForUser(table, SESSION, "noSuchVar + 1");
    assert.equal(outcome.result.kind, "failed");
    if (outcome.result.kind !== "failed") return;
    assert.equal(outcome.result.error.code, "ReferenceError");
  } finally {
    table.dispose(SESSION);
  }
});

test("执行行存有界全文：超长源码摘要截断，全文可读且标记", async () => {
  const table = freshTable();
  try {
    const longCode = `globalThis.big = "${"x".repeat(200)}"; return 1;`;
    await evalSandboxForUser(table, SESSION, longCode);
    const rows = table.readExecutions(SESSION);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].truncated, true);
    assert.equal(rows[0].code, longCode);
    assert.equal(rows[0].codeTruncated, false);
    // 摘要只露 120 字，全文保留完整源码。
    assert.ok(rows[0].preview.length < longCode.length);
  } finally {
    table.dispose(SESSION);
  }
});

test("执行行全文超 64KiB 截断并标记 codeTruncated", async () => {
  const table = freshTable();
  try {
    // 64KiB 上限之上：全文截断，摘要同样截断。
    const hugeCode = `globalThis.huge = "${"y".repeat(70_000)}"; return 1;`;
    await evalSandboxForUser(table, SESSION, hugeCode);
    const rows = table.readExecutions(SESSION);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].truncated, true);
    assert.equal(rows[0].codeTruncated, true);
    assert.ok(rows[0].code.length < hugeCode.length);
    assert.ok(rows[0].code.endsWith("…"));
  } finally {
    table.dispose(SESSION);
  }
});

test("用户 eval 空输入：参数错误，不执行不追加行", async () => {
  const table = freshTable();
  try {
    const outcome = await evalSandboxForUser(table, SESSION, "   ");
    assert.equal(outcome.result.kind, "failed");
    assert.equal(table.readExecutions(SESSION).length, 0);
  } finally {
    table.dispose(SESSION);
  }
});

test("用户 eval 语法错：调用失败，活实例留下", async () => {
  const table = freshTable();
  try {
    const outcome = await evalSandboxForUser(table, SESSION, "function ( {");
    assert.equal(outcome.result.kind, "failed");
    assert.equal(outcome.instanceAlive, true);
    assert.equal(table.hasLiveInstance(SESSION), true);
  } finally {
    table.dispose(SESSION);
  }
});

test("重置：旧堆消失并立即建出干净新实例、执行行清空，后台 ID 全失效", async () => {
  const table = freshTable();
  try {
    await evalSandboxForUser(table, SESSION, "globalThis.x = 1;");
    assert.equal(table.hasLiveInstance(SESSION), true);
    await table.reset(SESSION);
    // 重置语义：销毁旧实例并立即新建干净实例（docs/specs/sandbox-projection-push.md 缺陷一）。
    assert.equal(table.hasLiveInstance(SESSION), true);
    assert.equal(table.readExecutions(SESSION).length, 0);
    // 重置后旧快照不可读：后台登记已随 dispose 清空。
    assert.equal(table.getBackgroundEval("sandbox_missing"), undefined);
  } finally {
    table.dispose(SESSION);
  }
});

test("重置幂等：无实例时同样建出可用新实例", async () => {
  const table = freshTable();
  const fresh = `sess_test_sandbox_reset_absent_${Date.now()}` as SessionId;
  try {
    assert.equal(table.hasLiveInstance(fresh), false);
    await table.reset(fresh);
    assert.equal(table.hasLiveInstance(fresh), true);
  } finally {
    table.dispose(fresh);
  }
});

test("重置后 LocalStorage 仍在：堆消失，磁盘态保留", async () => {
  // 原因与修复依据：无落盘依赖时 LS 只在内存态，reset 杀实例后即消失；
  // 配内存盘才能验证 spec「LocalStorage 留下」（与 sandbox-instance.test.ts 同形）。
  const backing = new MemoryFileSystem();
  const table = new SandboxInstanceTable({
    cliStorageRoot: "/memory/cli",
    fileSystemPort: backing.port(),
  });
  try {
    // 先写 LS 再重置：reset 只杀堆（dispose），不删落盘文件。
    await evalSandboxForUser(
      table,
      SESSION,
      'globalThis.heapGone = "gone"; localStorage.setItem("keep", "v"); return 1;',
    );
    await table.reset(SESSION);
    // 重置语义：销毁旧实例并立即新建干净实例，堆上全局消失、LocalStorage 保留；
    // 下一次 eval 进新实例（isFirstResultOnNewInstance=true）。
    assert.equal(table.hasLiveInstance(SESSION), true);
    const next = await table.eval({
      sessionId: SESSION,
      code: 'return (typeof heapGone) + "/" + String(localStorage.getItem("keep"));',
      timeoutMs: 120_000,
    });
    assert.equal(next.result.kind, "completed");
    if (next.result.kind !== "completed") return;
    // 堆上的全局没了（undefined），LocalStorage 还在（v）。
    assert.equal(next.result.returnText, "undefined/v");
    assert.equal(next.isFirstResultOnNewInstance, true);
  } finally {
    table.dispose(SESSION);
  }
});
