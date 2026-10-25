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
import { compactToolEntry } from "../src/tool/handlers/compact.js";

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

test("四档各自原样保留，缺省与未知值都落到完全访问", () => {
  assert.equal(resolveExecutionState({ mode: "plan" }).mode, "plan");
  assert.equal(resolveExecutionState({ mode: "readonly" }).mode, "readonly");
  assert.equal(resolveExecutionState({ mode: "yolo" }).mode, "yolo");
  assert.equal(resolveExecutionState({ mode: "team" }).mode, "team");
  // 权限轴已删掉 build / edit / auto，旧值 bare 也改为显式迁移；未知名必须落到默认档。
  for (const legacy of ["build", "edit", "auto", "bare", "", "nonsense"]) {
    assert.equal(resolveExecutionState({ mode: legacy }).mode, "yolo", legacy);
  }
});

test("输入不含 mode 时沿用当前值，不会被默认值抹掉", () => {
  const current = resolveExecutionState({ mode: "readonly" });
  assert.equal(resolveExecutionState({}, current).mode, "readonly");
  assert.equal(resolveExecutionState({ mode: "build" }, current).mode, "readonly");
});

test("executionStateSchema 只认四值，旧对象形态解析失败", () => {
  assert.equal(executionStateSchema.safeParse({ mode: "readonly" }).success, true);
  assert.equal(executionStateSchema.safeParse({ mode: "team" }).success, true);
  // 旧值 bare 不能通过 schema —— 迁移必须显式走 normalizeLegacyExecutionMode。
  assert.equal(executionStateSchema.safeParse({ mode: "bare" }).success, false);
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

test("迁移函数对新格式是恒等映射，旧秘书档 bare 整体迁移为 team", () => {
  for (const mode of ["plan", "readonly", "yolo", "team"] as const) {
    assert.equal(normalizeLegacyExecutionMode({ mode }), mode);
    assert.equal(normalizeLegacyExecutionMode(mode), mode);
  }
  // docs/specs/team-mode.md「迁移」：Bare 改名 Team，旧值两种形态都收。
  assert.equal(normalizeLegacyExecutionMode("bare"), "team");
  assert.equal(normalizeLegacyExecutionMode({ mode: "bare" }), "team");
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

// 本用例不传 toolCapability，走的是 isDestructiveTool 的工具名兜底，和运行时
// 「先铺 entry.metadata」那条路径不是一回事，所以用例名不宣称 Bash 是破坏性工具。
test("只读模式下 Bash 未命中只读放行集而被拒绝", () => {
  const decision = service.checkPermission(
    context({ mode: "readonly", toolName: "Bash", riskLevel: "high" }),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "mode.readonly.nonReadOnly");
});

// 锁住「拒绝理由说的是不在放行集内，而不是工具有破坏性」。
// Bash/Write/Edit 的 metadata 都是 destructive: false，pnpm lint 这类无副作用命令
// 被拒的真实原因只是没进只读白名单，文案一旦写回 non-destructive 就会误导成「工具危险」。
test("兜底拒绝不暗示工具有破坏性：无破坏但非只读的调用同样被拒", () => {
  const decision = service.checkPermission(
    context({ mode: "plan", toolName: "Bash", input: { command: "pnpm lint" } }),
    { readOnly: false, destructive: false },
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "mode.plan.nonReadOnly");
  assert.match(decision.reason ?? "", /not among them/);
  assert.doesNotMatch(decision.reason ?? "", /destructive/);
});

test("权限拒绝结果携带可持久化的结构化原因和来源", () => {
  const result = createPermissionErrorResult(
    { id: "call-bash", name: "Bash", input: { command: "git tag release" } },
    "Ask mode only allows read-only tools; this tool call is not among them",
    { source: "policy", ruleId: "mode.readonly.nonReadOnly" },
  );

  assert.equal(result.success, false);
  assert.deepEqual(result.permissionDenial, {
    decision: "deny",
    reason: "Ask mode only allows read-only tools; this tool call is not among them",
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

test("Compact 在 Ask/Plan mode 通过显式 session 能力放行", () => {
  for (const [mode, ruleId] of [
    ["readonly", "mode.readonly.explicitSessionCapability"],
    ["plan", "mode.plan.explicitSessionCapability"],
  ] as const) {
    const decision = service.checkPermission(
      context({ mode, toolName: "Compact" }),
      compactToolEntry.metadata,
    );
    assert.equal(decision.decision, "allow");
    assert.equal(decision.ruleId, ruleId);
  }
});

// Team 无独立权限分支：与 yolo 同路径整档放行（docs/specs/team-mode.md）。
// 原 Bare 秘书白名单已废弃，不存在 mode.team.* 拒绝码。
test("Team 档与完全访问同路径放行，无独立规则号", () => {
  for (const toolName of ["Read", "Write", "Bash", "JSVM", "Agent", "EnterPlanMode", "Sandbox"]) {
    const decision = service.checkPermission(context({ mode: "team", toolName }));
    assert.equal(decision.decision, "allow", toolName);
    assert.equal(decision.ruleId, "mode.yolo");
  }
});

test("Team 档的判定顺序与 yolo 完全一致（整档放行在 disallowedTools 与项目规则之前）", () => {
  // 权限顺序：yolo/team 整档放行排在 disallowedTools 与项目 deny/ask 之前，
  // Team 必须继承同一条顺序，不得悄悄挪动。
  const serviceWithDisallow = new PermissionService({
    ...defaultPermissionConfig,
    disallowedTools: new Set(["Write"]),
  });
  const yoloDecision = serviceWithDisallow.checkPermission(
    context({ mode: "yolo", toolName: "Write" }),
  );
  const teamDecision = serviceWithDisallow.checkPermission(
    context({ mode: "team", toolName: "Write" }),
  );
  assert.equal(yoloDecision.decision, "allow");
  assert.equal(teamDecision.decision, yoloDecision.decision);
  assert.equal(teamDecision.ruleId, yoloDecision.ruleId);

  const projectRules = {
    version: 1 as const,
    rules: [
      {
        toolName: "Read",
        behavior: "deny" as const,
      },
    ],
  };
  const yoloProject = service.checkPermission(
    context({ mode: "yolo", toolName: "Read" }),
    undefined,
    projectRules,
  );
  const teamProject = service.checkPermission(
    context({ mode: "team", toolName: "Read" }),
    undefined,
    projectRules,
  );
  assert.equal(yoloProject.decision, "allow");
  assert.equal(teamProject.decision, yoloProject.decision);
  assert.equal(teamProject.ruleId, yoloProject.ruleId);
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

test("四档标签固定为 Plan / Ask / Agent / Team", () => {
  // 显示名与内部值解耦：模型看不到 plan / readonly / yolo / team 内部值。
  assert.equal(buildRuntimeModeReminderBody("plan"), "<mode>Plan</mode>");
  assert.equal(buildRuntimeModeReminderBody("readonly"), "<mode>Ask</mode>");
  assert.equal(buildRuntimeModeReminderBody("yolo"), "<mode>Agent</mode>");
  assert.equal(buildRuntimeModeReminderBody("team"), "<mode>Team</mode>");
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

test("四档行为指令只在系统 Prompt 的 Collaboration modes 段，且内容与档位无关", () => {
  const section = buildCollaborationModesSection();
  for (const mode of ["plan", "readonly", "yolo", "team"] as const) {
    assert.ok(
      section.content.includes(buildRuntimeModeReminderBody(mode)),
      `${mode} 的标签必须能在系统段里找到对应说明`,
    );
  }
  // 静态内容：三档说明恒在，切档不改系统 Prompt（保前缀缓存）。
  assert.equal(buildCollaborationModesSection().content, section.content);
  assert.equal(section.injectionTarget, "system");
});

test("Ask 档文案必须指引先调 EnterPlanMode 再提交计划，不教模型贴全文", () => {
  // CreatePlan 已收归 Plan 专属（plan-card-execute.md）：Ask 档文案必须指引模型
  // 先调 EnterPlanMode 切进 Plan 再提交，而不是直接调 CreatePlan，更不能贴全文。
  // 取 Ask 档那一条 bullet（开头的总述行也含同名标签，按 bullet 前缀挑）。
  const askLine = buildCollaborationModesSection().content
    .split("\n")
    .find((line) => line.startsWith("- `<mode>Ask</mode>`"));
  assert.ok(askLine, "系统段必须保留 Ask 档说明");
  assert.match(askLine, /EnterPlanMode/);
  assert.match(askLine, /CreatePlan/);
  assert.match(askLine, /rather than pasting the plan as prose/);
});

test("Agent 档文案必须提及先出方案时调 EnterPlanMode", () => {
  const agentLine = buildCollaborationModesSection().content
    .split("\n")
    .find((line) => line.startsWith("- `<mode>Agent</mode>`"));
  assert.ok(agentLine, "系统段必须保留 Agent 档说明");
  assert.match(agentLine, /EnterPlanMode/);
  assert.match(agentLine, /CreatePlan/);
});

// Team 行是授权式引导（用户基调「善用子代理，但对质量把关」），不写禁令清单。
test("Team 档文案是授权式派工引导，含技能指针", () => {
  const teamLine = buildCollaborationModesSection().content
    .split("\n")
    .find((line) => line.startsWith("- `<mode>Team</mode>`"));
  assert.ok(teamLine, "系统段必须保留 Team 档说明");
  assert.match(teamLine, /subagents/i);
  assert.match(teamLine, /quality/i);
  assert.match(teamLine, /`team` skill/);
  assert.match(teamLine, /Skill tool/);
  // 引导式文案不写秘书禁令与手册细节。
  assert.doesNotMatch(teamLine, /secretary/i);
  assert.doesNotMatch(teamLine, /context_remaining_percent/);
});

test("Collaboration modes 段必须交代 Ask/Plan 优先用 JSVM 做 JS 计算", () => {
  const section = buildCollaborationModesSection().content;
  assert.match(section, /JSVM routing:/);
  assert.match(section, /Ask and Plan, prefer the `JSVM` tool/);
  assert.match(section, /small command allowlist/);
  assert.match(section, /does not mean the command had side effects/);
  assert.doesNotMatch(section, /read-only Bash subset/);
  assert.match(section, /Global `fetch` talks to servers/);
  assert.match(section, /never asks/);
  assert.match(section, /In Agent and Team, use whichever tool fits/);
  assert.match(section, /`sandbox` skill/);
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

test("升级前落盘的旧 receipt（previousMode 是 build / bare）仍能解析并重试", () => {
  // 全访问 receipt 记录的永远是授权后的完全访问状态，旧格式的差异只在 previousMode 上：
  // 旧 receipt 可能写着 build / edit / auto / bare，所以这个字段必须保持宽值域。
  for (const previousMode of ["build", "edit", "auto", "bare"] as const) {
    const parsed = permissionFullAccessReceiptSchema.safeParse(
      fullAccessReceipt({
        planEnabled: false,
        previousMode,
        previousPlanEnabled: false,
      }),
    );
    assert.equal(parsed.success, true, previousMode);
  }
});
