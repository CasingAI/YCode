import assert from "node:assert/strict";
import test from "node:test";
import { resolveAutomationSubmissionModelSelection } from "../src/host/automationModelSelection.js";

// 自动化组钉死（docs/specs/model-group.md）：执行时刻现读组名单哈希钉死；
// 失败抛 modelGroup.deleted / noMembers 同款错误，不回落首选；
// 已固定 run 直接复用，不重抽。

const MEMBER_VIEW = {
  modelGroups: [
    {
      groupId: "model-group:free",
      name: "免费组",
      members: [
        { providerId: "zcode", modelId: "glm-5", available: true },
        { providerId: "zcode", modelId: "glm-4", available: false },
      ],
    },
  ],
};

const PINNED = {
  providerId: "zcode",
  modelId: "glm-5",
  options: { reasoningLevel: "high" },
};

function serviceFor(view: unknown) {
  return {
    getView: async (input?: unknown) => {
      if (input && typeof input === "object" && "selection" in (input as Record<string, unknown>)) {
        return { effectiveSelection: PINNED } as never;
      }
      return view as never;
    },
  };
}

const INTENT = { groupId: "model-group:free", groupNameSnapshot: "免费组旧名" };

test("组意图钉死可用成员并补默认档", async () => {
  const selection = await resolveAutomationSubmissionModelSelection({
    modelGroupIntent: INTENT,
    pickSeed: "run-1",
    modelSelectionService: serviceFor(MEMBER_VIEW),
  });
  assert.deepEqual(selection, PINNED);
});

test("同一 runId 同一名单抽回同一成员", async () => {
  const service = serviceFor(MEMBER_VIEW);
  const first = await resolveAutomationSubmissionModelSelection({
    modelGroupIntent: INTENT,
    pickSeed: "same-run",
    modelSelectionService: service,
  });
  const second = await resolveAutomationSubmissionModelSelection({
    modelGroupIntent: INTENT,
    pickSeed: "same-run",
    modelSelectionService: service,
  });
  assert.deepEqual(first, second);
});

test("组已删抛 modelGroup.deleted，不回落首选", async () => {
  await assert.rejects(
    resolveAutomationSubmissionModelSelection({
      modelGroupIntent: INTENT,
      pickSeed: "run-1",
      modelSelectionService: serviceFor({ modelGroups: [] }),
    }),
    /modelGroup\.deleted/,
  );
});

test("组无可用成员抛 modelGroup.noMembers", async () => {
  await assert.rejects(
    resolveAutomationSubmissionModelSelection({
      modelGroupIntent: INTENT,
      pickSeed: "run-1",
      modelSelectionService: serviceFor({
        modelGroups: [
          {
            groupId: "model-group:free",
            name: "免费组",
            members: [{ providerId: "zcode", modelId: "gone", available: false }],
          },
        ],
      }),
    }),
    /modelGroup\.noMembers/,
  );
});

test("已固定 run 直接复用，不读组名单", async () => {
  let reads = 0;
  const selection = await resolveAutomationSubmissionModelSelection({
    modelGroupIntent: INTENT,
    fixedSelection: PINNED,
    modelSelectionService: {
      getView: async () => {
        reads += 1;
        return {} as never;
      },
    },
  });
  assert.deepEqual(selection, PINNED);
  assert.equal(reads, 0);
});
