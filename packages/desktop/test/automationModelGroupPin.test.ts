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

test("新选时排除 selectable=false 成员，并按注入时刻筛降级窗口", async () => {
  const selectedModels: Array<{ providerId: string; modelId: string }> = [];
  const service = {
    getView: async (input?: unknown) => {
      if (input && typeof input === "object" && "selection" in (input as Record<string, unknown>)) {
        const selection = (input as { selection: { providerId: string; modelId: string } })
          .selection;
        selectedModels.push(selection);
        return {
          effectiveSelection: { ...selection, options: { reasoningLevel: "high" } },
        } as never;
      }
      return {
        modelGroups: [
          {
            groupId: INTENT.groupId,
            name: "免费组",
            members: [
              { providerId: "p", modelId: "disabled", available: true, selectable: false },
              {
                providerId: "p",
                modelId: "deprioritized",
                available: true,
                deprioritizeSchedule: {
                  timeZone: "UTC",
                  windows: [
                    { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startTime: "00:00", endTime: "24:00" },
                  ],
                },
              },
              { providerId: "p", modelId: "normal", available: true },
            ],
          },
        ],
      } as never;
    },
  };
  const selection = await resolveAutomationSubmissionModelSelection({
    modelGroupIntent: INTENT,
    pickSeed: "run-normal-pool",
    now: new Date("2026-01-05T12:00:00.000Z"),
    modelSelectionService: service,
  });
  assert.equal(selection.modelId, "normal");
  assert.deepEqual(selectedModels, [{ providerId: "p", modelId: "normal" }]);
});

test("Automation 所有成员不可新选时拒绝组选择", async () => {
  await assert.rejects(
    resolveAutomationSubmissionModelSelection({
      modelGroupIntent: INTENT,
      modelSelectionService: serviceFor({
        modelGroups: [
          {
            groupId: INTENT.groupId,
            name: "免费组",
            members: [{ providerId: "p", modelId: "disabled", available: true, selectable: false }],
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
