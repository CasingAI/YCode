// CLI 子智能体组钉死（docs/specs/model-group.md）：以子会话 ID 为种子，
// 对执行当下组名单哈希钉死；失败抛配置错误，不回落父模型。
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelGroupIntent, ModelSelection } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import { resolveSubagentModelGroupPin } from "../src/runtime/helpers/subagent-selection.js";

const INTENT: ModelGroupIntent = { groupId: "model-group:free", groupNameSnapshot: "免费组" };
const GROUPS = [
  {
    groupId: "model-group:free",
    name: "免费组",
    memberOrder: [
      { providerId: "zcode", modelId: "glm-5" },
      { providerId: "zcode", modelId: "glm-4" },
    ],
  },
];

function resolveSelection(selection: ModelSelection): EffectiveModelSelectionResult {
  return {
    effectiveSelection: {
      providerId: selection.providerId,
      modelId: selection.modelId,
      options: { reasoningLevel: "high" },
    },
  };
}

test("同一子会话 ID 同一名单钉死同一成员", async () => {
  const first = await resolveSubagentModelGroupPin({
    intent: INTENT,
    childSessionId: "child-1",
    groups: GROUPS,
    resolveSelection,
  });
  const second = await resolveSubagentModelGroupPin({
    intent: INTENT,
    childSessionId: "child-1",
    groups: GROUPS,
    resolveSelection,
  });
  assert.deepEqual(first, second);
  assert.ok(["glm-5", "glm-4"].includes(first.modelId));
  assert.equal(first.options?.reasoningLevel, "high");
});

test("不同子会话可钉死不同成员（种子生效）", async () => {
  const seen = new Set<string>();
  for (let index = 0; index < 20; index += 1) {
    const pinned = await resolveSubagentModelGroupPin({
      intent: INTENT,
      childSessionId: `child-${index}`,
      groups: GROUPS,
      resolveSelection,
    });
    seen.add(pinned.modelId);
  }
  // 中文注释：哈希种子不同必须能分散到不同成员，否则「各自钉死」语义不成立。
  assert.ok(seen.size > 1);
});

test("组已删抛 modelGroup.deleted", async () => {
  await assert.rejects(
    resolveSubagentModelGroupPin({ intent: INTENT, childSessionId: "child-1", groups: [] }),
    /modelGroup\.deleted/,
  );
});

test("无可用成员抛 modelGroup.noMembers", async () => {
  await assert.rejects(
    resolveSubagentModelGroupPin({
      intent: INTENT,
      childSessionId: "child-1",
      groups: GROUPS,
      resolveSelection: () => ({ effectiveSelection: null, selectionIssue: "model-not-found" }),
    }),
    /modelGroup\.noMembers/,
  );
});
