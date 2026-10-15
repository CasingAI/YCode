// ============================================================
// Sandbox 阶段2测试：always-on 注册、元数据档位、XOR、Ask/Plan 放行
// （学 session-history-tools.test.ts；权限对齐 Compact）
// ============================================================

import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_TOOL_NAME,
  SandboxInputSchema,
  SandboxOutputSchema,
  type SessionId,
  type ToolExecutionContext,
} from "@zcode/contracts";
import { ToolRegistryImpl } from "../src/tool/registry.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { sandboxToolEntry } from "../src/tool/handlers/sandbox.js";
import { configureSandboxTableDeps, getSandboxInstanceTable } from "../src/sandbox/session.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { buildExploreAllowedTools } from "../src/subagent/explore-tools.js";

function fakeContext(): ToolExecutionContext {
  return {
    toolCallId: "call_sandbox_1",
    abortSignal: new AbortController().signal,
    sessionId: "sess_sandbox_tool" as SessionId,
    workingDirectory: "/work",
    workspaceRoot: "/work",
  } as unknown as ToolExecutionContext;
}

test("Sandbox 裸 registerBuiltInTools 即出现（always-on、无 gate）", () => {
  const registry = new ToolRegistryImpl();
  registerBuiltInTools(registry);
  const metadata = registry.getMetadata(SANDBOX_TOOL_NAME);
  assert.ok(metadata, "Sandbox 应注册");
  assert.equal(metadata.name, SANDBOX_TOOL_NAME);
});

test("Sandbox 工具说明承认 fetch，不再写无网络", () => {
  const description = sandboxToolEntry.metadata.description ?? "";
  assert.match(description, /Global fetch talks to servers/);
  assert.match(description, /never asks/);
  assert.doesNotMatch(description, /No network/i);
});

test("Sandbox 元数据档位：非只读、非破坏、session 范围、免审批、Plan 放行", () => {
  const metadata = sandboxToolEntry.metadata;
  assert.equal(metadata.readOnly, false);
  assert.equal(metadata.destructive, false);
  assert.equal(metadata.sideEffectScope, "session");
  assert.equal(metadata.riskLevel, "medium");
  assert.equal(metadata.needsApproval, false);
  assert.equal(metadata.allowedInPlanMode, true);
});

test("Sandbox 权限对齐 Compact：session.sandbox.eval / medium / 免审批", () => {
  assert.equal(sandboxToolEntry.permission?.permission, "session.sandbox.eval");
  assert.equal(sandboxToolEntry.permission?.needsApproval, false);
  assert.equal(sandboxToolEntry.permission?.riskLevel, "medium");
  assert.equal(sandboxToolEntry.permission?.sideEffectScope, "session");
  assert.deepEqual(sandboxToolEntry.permission?.alwaysAllowPatternSources, ["toolName"]);
});

test("Sandbox 超时对齐 Bash：默认 120s、最大 600s", () => {
  assert.equal(sandboxToolEntry.timeout.defaultMs, 120_000);
  assert.equal(sandboxToolEntry.timeout.maxMs, 600_000);
});

test("Sandbox 入参 XOR：同时给或都不给源码与路径 → schema 拒绝", () => {
  assert.ok(SandboxInputSchema.safeParse({ description: "算一下", code: "return 1;" }).success);
  assert.ok(
    SandboxInputSchema.safeParse({ description: "读文件", filePath: "/work/a.js" }).success,
  );
  assert.equal(
    SandboxInputSchema.safeParse({ description: "都给", code: "return 1;", filePath: "/work/a.js" })
      .success,
    false,
  );
  assert.equal(SandboxInputSchema.safeParse({ description: "都不给" }).success, false);
  assert.equal(SandboxInputSchema.safeParse({ code: "return 1;" }).success, false);
});

test("Sandbox 前台 return 1+1 → 成功，结果为 2", async () => {
  const output = SandboxOutputSchema.parse(
    await sandboxToolEntry.handler({ description: "算一下", code: "return 1+1;" }, fakeContext()),
  );
  assert.equal(output.status, "success");
  assert.equal(output.returnText, "2");
});

test("Sandbox 同时给源码和路径 → 工具失败", async () => {
  await assert.rejects(
    () =>
      sandboxToolEntry.handler(
        { description: "都给", code: "return 1;", filePath: "/work/a.js" },
        fakeContext(),
      ),
    /exactly one of `code` and `filePath`/,
  );
});

test("Sandbox 语法错 → 工具失败", async () => {
  await assert.rejects(
    () => sandboxToolEntry.handler({ description: "语法错", code: "function ( {" }, fakeContext()),
    /./,
  );
});

test("Sandbox 新实例第一次返回带提示位与 system-reminder 文案", async () => {
  // 原因与修复依据：用独立 sessionId 保证这是新实例的第一次调用。
  const fresh = `sess_sandbox_fresh_${Date.now()}` as SessionId;
  const context = { ...fakeContext(), sessionId: fresh } as ToolExecutionContext;
  const output = SandboxOutputSchema.parse(
    await sandboxToolEntry.handler({ description: "第一次", code: "return 1;" }, context),
  );
  assert.equal(output.isNewInstance, true);
  const text = sandboxToolEntry.formatModelContent?.(output) ?? "";
  assert.ok(text.includes("新沙盒实例"));
  assert.ok(text.includes("LocalStorage 还在"));
});

test("Sandbox 新实例第一次失败：错误文本携带提示，下次成功仍带且只一次", async () => {
  // 原因与修复依据：spec「只写这一次（以成功为准）」——第一次失败不消耗提示位，
  // 失败文本里携带提示；下一次成功仍带，之后不再重复。
  const fresh = `sess_sandbox_failfirst_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}` as SessionId;
  const context = { ...fakeContext(), sessionId: fresh } as ToolExecutionContext;
  try {
    const failure = await sandboxToolEntry.handler(
      { description: "先失败", code: "function ( {" },
      context,
    ).then(
      () => { throw new Error("应当失败"); },
      (error: unknown) => error,
    );
    const message = failure instanceof Error ? failure.message : String(failure);
    assert.ok(message.includes("新沙盒实例"));
    assert.ok(message.includes("LocalStorage 还在"));
    // 下一次成功：仍带提示位。
    const next = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler({ description: "再成功", code: "return 1;" }, context),
    );
    assert.equal(next.isNewInstance, true);
    // 第三次：不再重复。
    const third = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler({ description: "第三次", code: "return 2;" }, context),
    );
    assert.equal(third.isNewInstance, undefined);
  } finally {
    getSandboxInstanceTable().dispose(fresh);
  }
});

test("Ask/Plan 档放行 Sandbox（Compact 同款第三条规则）", () => {
  const service = new PermissionService(defaultPermissionConfig);
  for (const [mode, ruleId] of [
    ["readonly", "mode.readonly.explicitSessionCapability"],
    ["plan", "mode.plan.explicitSessionCapability"],
  ] as const) {
    const decision = service.checkPermission(
      { toolName: SANDBOX_TOOL_NAME, input: {}, riskLevel: "medium", mode },
      sandboxToolEntry.metadata,
    );
    assert.equal(decision.decision, "allow");
    assert.equal(decision.ruleId, ruleId);
  }
});

test("Explore 白名单含 Sandbox", () => {
  assert.ok((buildExploreAllowedTools() as readonly string[]).includes(SANDBOX_TOOL_NAME));
});

test("Explore embedded-search 分支同样可见 Sandbox", () => {
  // 原因与修复依据：文件头注释写明 Sandbox 对 explore 可见，embedded 分支只收掉
  // Glob/Grep（由 Bash find/grep 接管），计算面不应随搜索分支消失。
  const embedded = buildExploreAllowedTools({ embeddedSearchEnabled: true }) as readonly string[];
  assert.ok(embedded.includes(SANDBOX_TOOL_NAME));
});

test("reset 参数：先销毁再在新实例跑，LocalStorage 保留", async () => {
  // 原因与修复依据：LS 保留靠磁盘落盘；工具 handler 走进程单例表，测试里配内存盘。
  const files = new Map<string, string>();
  configureSandboxTableDeps({
    cliStorageRoot: "/memory/cli",
    fileSystemPort: {
      createDirectory: async () => ({ path: "" }),
      readTextFile: async (request: { path: string }) => {
        const content = files.get(request.path);
        if (content === undefined) throw new Error(`missing: ${request.path}`);
        return { content };
      },
      writeTextFile: async (request: { path: string; content: string }) => {
        files.set(request.path, request.content);
        return { path: request.path, bytesWritten: request.content.length };
      },
    } as never,
  });
  const sessionId = `sess_sandbox_reset_${Date.now()}` as SessionId;
  const context = { ...fakeContext(), sessionId } as ToolExecutionContext;
  try {
    const first = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler(
        { description: "埋值", code: 'globalThis.epoch = 1; localStorage.setItem("k", "v"); return 1;' },
        context,
      ),
    );
    assert.equal(first.isNewInstance, true);

    const second = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler(
        { description: "重置再跑", code: 'return (typeof epoch) + "/" + String(localStorage.getItem("k"));', reset: true },
        context,
      ),
    );
    // 原因与修复依据：重置销毁堆但保留 LocalStorage；新实例第一次返回带提示。
    assert.equal(second.returnText, "undefined/v");
    assert.equal(second.isNewInstance, true);
  } finally {
    getSandboxInstanceTable().dispose(sessionId);
    configureSandboxTableDeps({ cliStorageRoot: undefined, fileSystemPort: undefined });
  }
});
