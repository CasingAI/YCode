import assert from "node:assert/strict";
import test from "node:test";
import {
  executionStateSchema,
  normalizeLegacyExecutionMode,
  resolveExecutionState,
} from "@zcode/shared";
import { permissionFullAccessReceiptSchema } from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import type { PermissionContext } from "../src/permission/service.js";
import { buildRuntimeModeReminderBody } from "../src/runtime/helpers/runtime-reminders.js";
import { buildCollaborationModesSection } from "../src/context/dynamic-sections.js";
import { createPermissionErrorResult } from "../src/tool/executor/errors.js";

function context(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    toolName: "Read",
    input: {},
    riskLevel: "low",
    mode: "yolo",
    ...overrides,
  };
}

const service = new PermissionService();

// ---------------------------------------------------------------
// resolveExecutionState：单值轴
// ---------------------------------------------------------------

test("三档各自原样保留，缺省与未知值都落到完全访问", () => {
  assert.equal(resolveExecutionState({ mode: "plan" }).mode, "plan");
  assert.equal(resolveExecutionState({ mode: "readonly" }).mode, "readonly");
  assert.equal(resolveExecutionState({ mode: "yolo" }).mode, "yolo");
  // 权限轴已删掉 build / edit / auto，这里必须落到默认档而不是把它们带进运行时。
  for (const legacy of ["build", "edit", "auto", "", "nonsense"]) {
    assert.equal(resolveExecutionState({ mode: legacy }).mode, "yolo", legacy);
  }
});

test("输入不含 mode 时沿用当前值，不会被默认值抹掉", () => {
  const current = resolveExecutionState({ mode: "readonly" });
  assert.equal(resolveExecutionState({}, current).mode, "readonly");
  assert.equal(resolveExecutionState({ mode: "build" }, current).mode, "readonly");
});

test("executionStateSchema 只认三值，旧对象形态解析失败", () => {
  assert.equal(executionStateSchema.safeParse({ mode: "readonly" }).success, true);
  // 旧值不能通过 schema —— 迁移必须显式走 normalizeLegacyExecutionMode。
  assert.equal(executionStateSchema.safeParse({ mode: "build" }).success, false);
  assert.equal(
    executionStateSchema.safeParse({ mode: "build", planEnabled: true }).success,
    false,
  );
});

// ---------------------------------------------------------------
// normalizeLegacyExecutionMode：升级前数据的唯一迁移入口
// ---------------------------------------------------------------

test("旧叠加位优先于基础档：planEnabled 为真必须还原成计划模式", () => {
  assert.equal(normalizeLegacyExecutionMode({ mode: "build", planEnabled: true }), "plan");
  assert.equal(
    normalizeLegacyExecutionMode({ mode: "yolo", readOnlyEnabled: true }),
    "readonly",
  );
});

test("旧基础档：只有 plan 与 readonly 有意义，其余收敛到完全访问", () => {
  assert.equal(normalizeLegacyExecutionMode({ mode: "plan" }), "plan");
  assert.equal(normalizeLegacyExecutionMode("plan"), "plan");
  assert.equal(normalizeLegacyExecutionMode("readonly"), "readonly");
  for (const legacy of ["build", "edit", "auto", "autoEdit", undefined, null, 42, {}]) {
    assert.equal(normalizeLegacyExecutionMode(legacy), "yolo", String(legacy));
  }
});

test("迁移函数对新格式是恒等映射，可以安全地用在所有读取边界", () => {
  for (const mode of ["plan", "readonly", "yolo"] as const) {
    assert.equal(normalizeLegacyExecutionMode({ mode }), mode);
    assert.equal(normalizeLegacyExecutionMode(mode), mode);
  }
});

// ---------------------------------------------------------------
// 权限判定：三档分派与规则号
// ---------------------------------------------------------------

test("完全访问下写操作直接放行，规则号是 mode.yolo", () => {
  const decision = service.checkPermission(context({ toolName: "Write" }));
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.yolo");
});

test("只读模式下读类工具放行，规则号带 mode.readonly 前缀", () => {
  const decision = service.checkPermission(context({ mode: "readonly", toolName: "Read" }));
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.readonly.readOnly");
});

test("只读模式下写类工具被拒绝，且是 deny 而非 ask", () => {
  for (const toolName of ["Write", "Edit", "ApplyPatch"]) {
    const decision = service.checkPermission(context({ mode: "readonly", toolName }));
    assert.equal(decision.decision, "deny", `${toolName} 应被拒绝`);
    assert.equal(decision.ruleId, "mode.readonly.nonReadOnly");
  }
});

test("只读模式下 Bash 作为破坏性工具被拒绝", () => {
  const decision = service.checkPermission(
    context({ mode: "readonly", toolName: "Bash", riskLevel: "high" }),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "mode.readonly.nonReadOnly");
});

test("权限拒绝结果携带可持久化的结构化原因和来源", () => {
  const result = createPermissionErrorResult(
    { id: "call-bash", name: "Bash", input: { command: "git tag release" } },
    "Ask mode only allows read-only, non-destructive tools",
    { source: "policy", ruleId: "mode.readonly.nonReadOnly" },
  );

  assert.equal(result.success, false);
  assert.deepEqual(result.permissionDenial, {
    decision: "deny",
    reason: "Ask mode only allows read-only, non-destructive tools",
    source: "policy",
    ruleId: "mode.readonly.nonReadOnly",
  });
});

test("计划模式与只读模式共用放行口径，只有规则号前缀不同", () => {
  const planRead = service.checkPermission(context({ mode: "plan", toolName: "Read" }));
  assert.equal(planRead.decision, "allow");
  assert.equal(planRead.ruleId, "mode.plan.readOnly");

  const planWrite = service.checkPermission(context({ mode: "plan", toolName: "Write" }));
  assert.equal(planWrite.decision, "deny");
  assert.equal(planWrite.ruleId, "mode.plan.nonReadOnly");

  const readOnlyWrite = service.checkPermission(
    context({ mode: "readonly", toolName: "Write" }),
  );
  assert.equal(readOnlyWrite.decision, "deny");
  assert.equal(readOnlyWrite.ruleId, "mode.readonly.nonReadOnly");
});

test("受限档放行非破坏性 MCP 与显式 session 能力", () => {
  const mcp = service.checkPermission(
    context({ mode: "readonly", toolName: "mcp__demo__read" }),
    {
      permission: {
        permission: "mcp",
        reason: "读取外部数据",
        riskLevel: "low",
        sideEffectScope: "none",
        needsApproval: false,
        patternSources: [],
        denyPriority: "beforeAsk",
      },
    },
  );
  assert.equal(mcp.decision, "allow");
  assert.equal(mcp.ruleId, "mode.readonly.mcp");

  // 与 respond-to-coordinator 的声明同形：非只读工具，但显式声明了 session 侧效且免审批。
  const sessionCapability = service.checkPermission(
    context({ mode: "plan", toolName: "RespondToCoordinator" }),
    { allowedInPlanMode: true, sideEffectScope: "session", needsApproval: false },
  );
  assert.equal(sessionCapability.decision, "allow");
  assert.equal(sessionCapability.ruleId, "mode.plan.explicitSessionCapability");
});

test("受限档排在 allowedTools 之前，一条放行配置不能绕过只读", () => {
  const serviceWithAllowAll = new PermissionService({
    ...defaultPermissionConfig,
    allowedTools: new Set(["Write"]),
  });
  const decision = serviceWithAllowAll.checkPermission(
    context({ mode: "readonly", toolName: "Write" }),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "mode.readonly.nonReadOnly");
});

test("受限档排在项目 allow 规则之前，项目规则不能绕过只读", () => {
  const projectRules = {
    version: 1 as const,
    rules: [
      {
        source: "project" as const,
        behavior: "allow" as const,
        toolName: "Write",
      },
    ],
  };
  const decision = service.checkPermission(
    context({ mode: "plan", toolName: "Write" }),
    undefined,
    projectRules,
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "mode.plan.nonReadOnly");
});

// ---------------------------------------------------------------
// 模式标签：每条模型请求尾部注入的 <mode> 文本
// ---------------------------------------------------------------

test("三档标签固定为 <mode>Plan</mode> / <mode>Ask</mode> / <mode>Agent</mode>", () => {
  // 显示名与内部值解耦：模型只看得到 Plan / Ask / Agent，看不到 plan / readonly / yolo。
  assert.equal(buildRuntimeModeReminderBody("plan"), "<mode>Plan</mode>");
  assert.equal(buildRuntimeModeReminderBody("readonly"), "<mode>Ask</mode>");
  assert.equal(buildRuntimeModeReminderBody("yolo"), "<mode>Agent</mode>");
});

test("标签无节流：连续调用恒返回当前档标签，且不夹带行为散文", () => {
  // 行为指令在系统 Prompt 的 Collaboration modes 段；标签必须每个 model step 都在，
  // 否则回合中途切档后模型感知不到新档位。
  const first = buildRuntimeModeReminderBody("plan");
  const second = buildRuntimeModeReminderBody("plan");
  assert.equal(second, first);
  assert.equal(first, "<mode>Plan</mode>");
  // 标签里不得出现内部值或旧散文口径，避免模型把两套命名混着说。
  assert.doesNotMatch(first, /readonly|yolo|read-only|full access|is active/i);
});

test("三档行为指令只在系统 Prompt 的 Collaboration modes 段，且内容与档位无关", () => {
  const section = buildCollaborationModesSection();
  for (const mode of ["plan", "readonly", "yolo"] as const) {
    assert.ok(
      section.content.includes(buildRuntimeModeReminderBody(mode)),
      `${mode} 的标签必须能在系统段里找到对应说明`,
    );
  }
  // 静态内容：三档说明恒在，切档不改系统 Prompt（保前缀缓存）。
  assert.equal(buildCollaborationModesSection().content, section.content);
  assert.equal(section.injectionTarget, "system");
});

// ---------------------------------------------------------------
// 全访问 receipt 的兼容性（payload 是 strict schema）
// ---------------------------------------------------------------

function fullAccessReceipt(payload: Record<string, unknown>) {
  return {
    interactionId: "grant-1",
    event: {
      id: "evt-1",
      sessionId: "sess-1",
      traceId: "trace-1",
      type: "session_mode_changed",
      timestamp: "2026-09-21T00:00:00.000Z",
      sequenceNumber: 1,
      payload: {
        mode: "yolo",
        planEnabled: false,
        previousMode: "plan",
        previousPlanEnabled: true,
        source: "command",
        permissionGrant: { interactionId: "grant-1", queueItemIds: [] },
        ...payload,
      },
    },
  };
}

test("带派生只读位的全访问 receipt 能解析，授权重试不因新字段失败", () => {
  const parsed = permissionFullAccessReceiptSchema.safeParse(
    fullAccessReceipt({ readOnlyEnabled: false, previousReadOnlyEnabled: false }),
  );
  assert.equal(parsed.success, true);
});

test("升级前落盘的旧 receipt（previousMode 是 build）仍能解析并重试", () => {
  // 全访问 receipt 记录的永远是授权后的完全访问状态，旧格式的差异只在 previousMode 上：
  // 旧 receipt 可能写着 build / edit / auto，所以这个字段必须保持宽值域。
  const parsed = permissionFullAccessReceiptSchema.safeParse(
    fullAccessReceipt({
      planEnabled: false,
      previousMode: "build",
      previousPlanEnabled: false,
    }),
  );
  assert.equal(parsed.success, true);
});
