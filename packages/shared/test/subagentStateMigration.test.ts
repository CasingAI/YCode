import assert from "node:assert/strict";
import test from "node:test";
import { importSubagentStateSelections } from "../src/subagent-state-migration.js";

const SELECTION = { providerId: "zcode", modelId: "glm-5", options: { reasoningLevel: "high" } };

test("导入正式覆盖表时保留 Worker，不得只拷 Explore / 通用", () => {
  const next = importSubagentStateSelections({
    builtInModelSelectionOverrides: {
      Explore: SELECTION,
      "general-purpose": SELECTION,
      Worker: SELECTION,
    },
  });
  assert.deepEqual(next.builtInModelSelectionOverrides.Worker, SELECTION);
  assert.deepEqual(next.builtInModelSelectionOverrides.Explore, SELECTION);
  assert.deepEqual(next.builtInModelSelectionOverrides["general-purpose"], SELECTION);
});
