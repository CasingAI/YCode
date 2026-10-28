import assert from "node:assert/strict";
import test from "node:test";
import { createModelCatalogPort } from "../src/app/model-catalog-port.js";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";

const schedule = {
  timeZone: "America/Los_Angeles",
  windows: [{ daysOfWeek: [5, 6], startTime: "22:00", endTime: "02:00" }],
};

test("catalog snapshot 透传成员新选择策略并同时补目录档位快照", async () => {
  const port = createModelCatalogPort({
    registry: {
      getView: () =>
        ({
          revision: 1,
          providers: [
            {
              providerId: "p",
              models: [
                {
                  modelId: "m",
                  config: {
                    optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
                  },
                },
              ],
            },
          ],
        }) as never,
    } as unknown as ProviderRegistryModelSource,
    currentSelection: () => undefined,
    modelGroupsSource: async () =>
      [
        {
          groupId: "model-group:test",
          name: "测试组",
          memberOrder: [
            { providerId: "p", modelId: "m", selectable: false, deprioritizeSchedule: schedule },
            { providerId: "p", modelId: "missing", selectable: true },
          ],
        },
      ] as never,
  });

  const snapshots = await port.listModelGroupSnapshots?.();
  assert.deepEqual(snapshots, [
    {
      groupId: "model-group:test",
      name: "测试组",
      memberOrder: [
        {
          providerId: "p",
          modelId: "m",
          selectable: false,
          deprioritizeSchedule: schedule,
          supportedReasoningLevels: ["low", "high"],
          defaultReasoningLevel: "high",
        },
        {
          providerId: "p",
          modelId: "missing",
          selectable: true,
          supportedReasoningLevels: [],
        },
      ],
    },
  ]);
});
