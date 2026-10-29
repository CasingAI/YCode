import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveWebSearchProvider, WebSearchInput, WebSearchOutput } from "@zcode/contracts";
import type { WebSearchExecutor } from "@zcode/adapters/web-search";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createSessionPolicyWebSearchPort } from "../src/zcode-protocol/web-search-port.js";
import { updateWebSearchPolicy } from "../src/zcode-protocol/web-search-policy.js";

// spec: docs/specs/web-search-provider-capability.md
// 会话边界快照绑定：app 创建/恢复时对策略（开关+排序）定格，之后 workspace policy 的
// 写入（updateWebSearchPolicy 只整体替换字段）只影响之后创建的会话；已活跃会话的
// 工具面与激活搜索源保持创建时状态，与 dynamic-workflow / off-peak 策略同构。

const WORKSPACE = {
  workspacePath: "C:/ws/demo",
  workspaceKey: "C:/ws/demo",
};

interface CapturedPolicy {
  enabled: boolean;
  order?: string[];
}

function capturingExecutor(): WebSearchExecutor & { policies: CapturedPolicy[] } {
  const policies: CapturedPolicy[] = [];
  return {
    policies,
    resolveActiveProvider(policy: CapturedPolicy) {
      policies.push(policy);
      return policy.enabled
        ? ({ providerId: "personal:x", templateId: "deepseek" } as ActiveWebSearchProvider)
        : undefined;
    },
    async search(input: WebSearchInput): Promise<WebSearchOutput> {
      return { query: input.query, results: [], sources: [], durationMs: 1 };
    },
    dispose(): void {},
  } as unknown as WebSearchExecutor & { policies: CapturedPolicy[] };
}

function context(): ZCodeProtocolAgentServerContext {
  return {
    appRuntimePreferences: {
      webSearchEnabled: true,
      webSearchProviderOrder: ["p-a", "p-b"],
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("会话快照端口：创建后翻转 policy，旧端口仍按创建时策略解析", async () => {
  const target = context();
  const executorBefore = capturingExecutor();
  const portBefore = createSessionPolicyWebSearchPort({
    executor: executorBefore,
    context: target,
  });

  await updateWebSearchPolicy(target, {
    workspace: WORKSPACE,
    enabled: false,
    providers: ["p-z"],
  });

  assert.equal(portBefore.resolveActiveProvider()?.providerId, "personal:x");
  assert.deepEqual(executorBefore.policies, [{ enabled: true, order: ["p-a", "p-b"] }]);

  const executorAfter = capturingExecutor();
  const portAfter = createSessionPolicyWebSearchPort({
    executor: executorAfter,
    context: target,
  });
  assert.equal(portAfter.resolveActiveProvider(), undefined);
  assert.deepEqual(executorAfter.policies, [{ enabled: false, order: ["p-z"] }]);
});

test("会话快照端口：排序数组的就地变更不泄漏进快照", () => {
  const target = context();
  const executor = capturingExecutor();
  const port = createSessionPolicyWebSearchPort({ executor, context: target });

  target.appRuntimePreferences.webSearchProviderOrder?.push("p-injected");

  port.resolveActiveProvider();
  assert.deepEqual(executor.policies, [{ enabled: true, order: ["p-a", "p-b"] }]);
});

test("会话快照端口：executor 缺席时 fail-closed", () => {
  const port = createSessionPolicyWebSearchPort({ context: context() });
  assert.equal(port.resolveActiveProvider(), undefined);
});
