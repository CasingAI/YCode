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
      {
        providerId: "zcode",
        modelId: "glm-5",
        supportedReasoningLevels: ["low", "high"],
        defaultReasoningLevel: "high",
      },
      {
        providerId: "zcode",
        modelId: "glm-4",
        supportedReasoningLevels: ["low", "high"],
        defaultReasoningLevel: "high",
      },
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
    groups: GROUPS.map((group) => ({
      ...group,
      memberOrder: group.memberOrder.map((member) => ({
        ...member,
        supportedReasoningLevels: ["low", "high"],
        defaultReasoningLevel: "high",
      })),
    })),
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

test("子智能体组成员绑定档位优先于解析出的默认档", async () => {
  const bound = await resolveSubagentModelGroupPin({
    intent: INTENT,
    childSessionId: "child-bound",
    groups: [
      {
        ...GROUPS[0]!,
        memberOrder: [
          {
            providerId: "zcode",
            modelId: "glm-5",
            reasoningLevel: "low",
            supportedReasoningLevels: ["low", "high"],
            defaultReasoningLevel: "high",
          },
        ],
      },
    ],
    resolveSelection,
  });
  assert.equal(bound.modelId, "glm-5");
  assert.equal(bound.options?.reasoningLevel, "low");
});

test("成员绑定档位已不受支持时退回模型默认档", async () => {
  const resolved = await resolveSubagentModelGroupPin({
    intent: INTENT,
    childSessionId: "child-invalid-bound",
    groups: [
      {
        ...GROUPS[0]!,
        memberOrder: [
          {
            providerId: "zcode",
            modelId: "glm-5",
            reasoningLevel: "invalid",
            supportedReasoningLevels: ["low", "high"],
            defaultReasoningLevel: "high",
          },
        ],
      },
    ],
    resolveSelection: (selection) => {
      assert.notEqual(selection.options?.reasoningLevel, "invalid");
      return resolveSelection(selection);
    },
  });
  assert.equal(resolved.options?.reasoningLevel, "high");
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

/**
 * 复刻 `packages/provider` 的档位校验口径：Selection 必须带 reasoningLevel，
 * 且档位必须属于模型当前支持表；缺档位判 `reasoning-level-missing`。
 * 真实子智能体链路走的就是这条校验，探测不带档位时组成员会被全判不可用。
 */
function strictResolveSelection(
  supportedLevels: readonly string[],
): (selection: ModelSelection) => EffectiveModelSelectionResult {
  return (selection) => {
    const reasoningLevel = selection.options?.reasoningLevel;
    if (reasoningLevel === undefined) {
      return { effectiveSelection: null, selectionIssue: "reasoning-level-missing" };
    }
    if (!supportedLevels.includes(reasoningLevel)) {
      return { effectiveSelection: null, selectionIssue: "reasoning-level-not-supported" };
    }
    return {
      effectiveSelection: { ...selection, options: { reasoningLevel } },
    };
  };
}

test("成员可用性探测必须带档位：带档位探测才能把组内成员判为可用", async () => {
  const pinned = await resolveSubagentModelGroupPin({
    intent: INTENT,
    childSessionId: "child-strict",
    groups: [
      {
        groupId: INTENT.groupId,
        name: INTENT.groupNameSnapshot,
        memberOrder: [
          {
            providerId: "opencode-go-chat",
            modelId: "minimax-m3.1-flash-free",
            reasoningLevel: "high",
            supportedReasoningLevels: ["low", "high", "max"],
            defaultReasoningLevel: "high",
          },
        ],
      },
    ],
    resolveSelection: strictResolveSelection(["low", "high", "max"]),
  });
  assert.equal(pinned.providerId, "opencode-go-chat");
  assert.equal(pinned.modelId, "minimax-m3.1-flash-free");
  assert.equal(pinned.options?.reasoningLevel, "high");
});

test("绑定档位已不受支持时探测用默认档，成员仍判可用", async () => {
  const probedLevels: Array<string | undefined> = [];
  const pinned = await resolveSubagentModelGroupPin({
    intent: INTENT,
    childSessionId: "child-strict-fallback",
    groups: [
      {
        groupId: INTENT.groupId,
        name: INTENT.groupNameSnapshot,
        memberOrder: [
          {
            providerId: "opencode-go-chat",
            modelId: "minimax-m3.1-flash-free",
            reasoningLevel: "max",
            supportedReasoningLevels: ["low", "high"],
            defaultReasoningLevel: "high",
          },
        ],
      },
    ],
    resolveSelection: (selection) => {
      probedLevels.push(selection.options?.reasoningLevel);
      return strictResolveSelection(["low", "high"])(selection);
    },
  });
  assert.deepEqual(probedLevels, ["high"]);
  assert.equal(pinned.options?.reasoningLevel, "high");
});

test("成员模型不在目录（无支持档位表）时判不可用并抛 modelGroup.noMembers", async () => {
  await assert.rejects(
    resolveSubagentModelGroupPin({
      intent: INTENT,
      childSessionId: "child-unknown-model",
      groups: [
        {
          groupId: INTENT.groupId,
          name: INTENT.groupNameSnapshot,
          memberOrder: [
            {
              providerId: "opencode-go-chat",
              modelId: "not-in-catalog",
              supportedReasoningLevels: [],
            },
          ],
        },
      ],
      resolveSelection: strictResolveSelection(["low", "high", "max"]),
    }),
    /modelGroup\.noMembers/,
  );
});
