import assert from "node:assert/strict";
import test from "node:test";
import type { Logger, McpToolDescriptor, SubagentExecutionFence } from "@zcode/contracts";
import {
  SUBAGENT_BROWSER_CONTROL_MODEL_TOOL_NAME,
  canDelegateSubagentBrowserUse,
  exposesHostNodeReplBrowserTool,
  issueSubagentBrowserGrant,
  type SubagentBrowserDelegationEligibility,
} from "../src/subagent/browser-delegation.js";

// spec: docs/specs/subagent-browser-use-delegation.md
// 授权矩阵是安全边界：必须同时满足父档位、父子权限、前台、执行 fence 和真实工具面。
// 这里锁住纯决策；grant 生命周期与 runtime 接线由 subagent-browser-delegation-runtime.test.ts
// 用真实 AgentRuntime 验证。

const FENCE: SubagentExecutionFence = {
  childSessionId: "subagent_child_1",
  fencingEpoch: 7,
  ownerRuntimeId: "runtime-1",
};

const NODE_REPL_TOOLS: readonly McpToolDescriptor[] = [
  {
    serverName: "node_repl",
    toolName: "js",
    inputSchema: { type: "object", properties: {} },
  },
];

function eligible(
  overrides: Partial<SubagentBrowserDelegationEligibility> = {},
): SubagentBrowserDelegationEligibility {
  return {
    parentMode: "yolo",
    browserUseEnabled: true,
    delegationAvailable: true,
    background: false,
    executionFence: FENCE,
    executionFenceValidationAvailable: true,
    builtInExplore: false,
    profilePermissionMode: undefined,
    childPermissionMode: "yolo",
    childToolAllowlist: [SUBAGENT_BROWSER_CONTROL_MODEL_TOOL_NAME],
    childMcpTools: NODE_REPL_TOOLS,
    ...overrides,
  };
}

test("父 yolo/team + 前台 + fence + 真实 node_repl js：允许授权", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ parentMode: "yolo" })), true);
  assert.equal(canDelegateSubagentBrowserUse(eligible({ parentMode: "team" })), true);
});

test("父 plan/readonly：即使其它条件齐全也不授权", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ parentMode: "plan" })), false);
  assert.equal(canDelegateSubagentBrowserUse(eligible({ parentMode: "readonly" })), false);
});

test("父未启用 Browser Use 或宿主未提供授权端口：不授权", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ browserUseEnabled: false })), false);
  assert.equal(canDelegateSubagentBrowserUse(eligible({ delegationAvailable: false })), false);
});

test("后台 child 不授权", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ background: true })), false);
});

test("没有执行 fence 不授权", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ executionFence: undefined })), false);
});

test("缺少权威 fence 校验（SessionStore 无 renew）不授权，缺省视为不可用", () => {
  assert.equal(
    canDelegateSubagentBrowserUse(eligible({ executionFenceValidationAvailable: false })),
    false,
  );
  assert.equal(
    canDelegateSubagentBrowserUse(eligible({ executionFenceValidationAvailable: undefined })),
    false,
  );
});

test("内置 Explore 按来源判定，不按名称", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ builtInExplore: true })), false);
});

test("profile 自身 plan/readonly 不授权；auto/undefined 且有效模式 yolo 可继续", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ profilePermissionMode: "plan" })), false);
  assert.equal(
    canDelegateSubagentBrowserUse(eligible({ profilePermissionMode: "readonly" })),
    false,
  );
  assert.equal(canDelegateSubagentBrowserUse(eligible({ profilePermissionMode: "auto" })), true);
  assert.equal(canDelegateSubagentBrowserUse(eligible({ profilePermissionMode: "yolo" })), true);
});

test("child 有效权限不是 yolo（例如 Explore 的 readonly）不授权", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ childPermissionMode: "readonly" })), false);
});

test("工具面只含通配 selector 不算包含真实 js 工具", () => {
  assert.equal(
    canDelegateSubagentBrowserUse(eligible({ childToolAllowlist: ["mcp__node_repl__*"] })),
    false,
  );
  assert.equal(canDelegateSubagentBrowserUse(eligible({ childToolAllowlist: ["mcp"] })), false);
});

test("同名自定义工具不能冒充宿主 node_repl js", () => {
  const impostor: readonly McpToolDescriptor[] = [
    {
      serverName: "custom-tools",
      // 模型可见名称甚至可以被伪造成同一个字符串，但身份仍不是 node_repl/js。
      name: SUBAGENT_BROWSER_CONTROL_MODEL_TOOL_NAME,
      toolName: "js",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  assert.equal(exposesHostNodeReplBrowserTool(impostor), false);
  assert.equal(canDelegateSubagentBrowserUse(eligible({ childMcpTools: impostor })), false);
});

test("child MCP 快照没有真实 node_repl js 时不授权", () => {
  assert.equal(canDelegateSubagentBrowserUse(eligible({ childMcpTools: [] })), false);
});

test("白名单经 disallow 过滤后缺少 js 时（未包含真实工具名）不授权", () => {
  assert.equal(
    canDelegateSubagentBrowserUse(eligible({ childToolAllowlist: ["Read", "Bash"] })),
    false,
  );
});

test("grant 失败只降级为浏览器不可用，不抛出", () => {
  const handle = issueSubagentBrowserGrant({
    delegationPort: {
      grant() {
        throw new Error("parent session is not active");
      },
      revoke() {},
      authorize() {
        return undefined;
      },
    },
    parentSessionId: "parent",
    childSessionId: "child",
    agentId: "agent",
    executionFence: FENCE,
  });
  assert.equal(handle, undefined);
});

test("revoke 幂等，且只带本次 grantId/child/fence", () => {
  const revokes: unknown[] = [];
  const handle = issueSubagentBrowserGrant({
    delegationPort: {
      grant(input) {
        return {
          grantId: "grant-1",
          workspaceKey: "workspace",
          workspacePath: "C:/workspace",
          clientMode: "desktop-continuous",
          issuedAt: 1,
          ...input,
        };
      },
      revoke(input) {
        revokes.push(input);
      },
      authorize() {
        return undefined;
      },
    },
    parentSessionId: "parent",
    childSessionId: "child",
    agentId: "agent",
    executionFence: FENCE,
    parentTurnId: "turn-1",
  });
  assert.ok(handle);
  handle.revoke();
  handle.revoke();
  assert.deepEqual(revokes, [
    { grantId: "grant-1", childSessionId: "child", executionFence: FENCE },
  ]);
});

test("授权日志只关联 child/agent，不出现父 session、fence 或 grantId", () => {
  const logs: unknown[] = [];
  const logger = {
    debug: (...args: unknown[]) => logs.push(args),
    warn: (...args: unknown[]) => logs.push(args),
  } as unknown as Logger;
  const handle = issueSubagentBrowserGrant({
    delegationPort: {
      grant(input) {
        return {
          grantId: "grant-secret",
          workspaceKey: "workspace",
          workspacePath: "C:/workspace",
          clientMode: "desktop-continuous",
          issuedAt: 1,
          ...input,
        };
      },
      revoke() {
        throw new Error("broker unavailable");
      },
      authorize() {
        return undefined;
      },
    },
    parentSessionId: "parent-session-secret",
    childSessionId: "child-1",
    agentId: "agent-1",
    executionFence: FENCE,
    logger,
  });
  assert.ok(handle);
  handle.revoke();

  const text = JSON.stringify(logs);
  assert.equal(text.includes("parent-session-secret"), false);
  assert.equal(text.includes("grant-secret"), false);
  assert.equal(text.includes("runtime-1"), false);
  assert.equal(text.includes("child-1"), true);
  assert.equal(text.includes("agent-1"), true);
});

test("revoke 抛错不覆盖执行结果", () => {
  const handle = issueSubagentBrowserGrant({
    delegationPort: {
      grant(input) {
        return {
          grantId: "grant-1",
          workspaceKey: "workspace",
          workspacePath: "C:/workspace",
          clientMode: "desktop-continuous",
          issuedAt: 1,
          ...input,
        };
      },
      revoke() {
        throw new Error("broker unavailable");
      },
      authorize() {
        return undefined;
      },
    },
    parentSessionId: "parent",
    childSessionId: "child",
    agentId: "agent",
    executionFence: FENCE,
  });
  assert.ok(handle);
  assert.doesNotThrow(() => handle.revoke());
});
