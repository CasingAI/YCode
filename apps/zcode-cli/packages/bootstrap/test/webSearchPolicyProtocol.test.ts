import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { updateWebSearchPolicy } from "../src/zcode-protocol/web-search-policy.js";

// spec: docs/specs/web-search-provider-capability.md
// 判定权在 Host：CLI 只把 workspace policy 写进 appRuntimePreferences（唯一缓存），
// providers 缺席表示用户从未整理过排序，必须清回 undefined 走派生默认序。

const WORKSPACE = {
  workspacePath: "C:/ws/demo",
  workspaceKey: "C:/ws/demo",
};

function context(): ZCodeProtocolAgentServerContext {
  return {
    appRuntimePreferences: {
      webSearchEnabled: false,
      webSearchProviderOrder: undefined,
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("workspace/updateWebSearchPolicy：写总开关与排序并回显", async () => {
  const target = context();
  const result = await updateWebSearchPolicy(target, {
    workspace: WORKSPACE,
    enabled: true,
    providers: ["p-zai", "p-ds"],
  });
  assert.equal(target.appRuntimePreferences.webSearchEnabled, true);
  assert.deepEqual(target.appRuntimePreferences.webSearchProviderOrder, ["p-zai", "p-ds"]);
  assert.deepEqual(result, {
    workspace: WORKSPACE,
    enabled: true,
    providers: ["p-zai", "p-ds"],
  });
});

test("workspace/updateWebSearchPolicy：providers 缺席清回 undefined（派生默认序）", async () => {
  const target = context();
  target.appRuntimePreferences.webSearchProviderOrder = ["stale-id"];
  const result = await updateWebSearchPolicy(target, {
    workspace: WORKSPACE,
    enabled: false,
  });
  assert.equal(target.appRuntimePreferences.webSearchEnabled, false);
  assert.equal(target.appRuntimePreferences.webSearchProviderOrder, undefined);
  assert.deepEqual(result, { workspace: WORKSPACE, enabled: false });
});

test("workspace/updateWebSearchPolicy：非法参数被 parseParams 拒绝且不污染缓存", async () => {
  const target = context();
  await assert.rejects(
    updateWebSearchPolicy(target, {
      workspace: WORKSPACE,
      enabled: "yes",
      extra: 1,
    }),
    (error: unknown) => (error as { code?: number }).code === -32602,
  );
  assert.equal(target.appRuntimePreferences.webSearchEnabled, false);
  assert.equal(target.appRuntimePreferences.webSearchProviderOrder, undefined);
});
