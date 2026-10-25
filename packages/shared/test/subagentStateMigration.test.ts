import assert from "node:assert/strict";
import test from "node:test";
import { importSubagentStateSelections } from "../src/subagent-state-migration.js";

const SELECTION = { providerId: "zcode", modelId: "glm-5", options: { reasoningLevel: "high" } };

test("正式字段存在时原样保留：不重建、不剔除未知名与脏值、不解释遗留双 map", () => {
  const input = {
    builtInModelSelectionOverrides: {
      Explore: SELECTION,
      "general-purpose": SELECTION,
      // 已废弃的 Worker 遗留键与未知名、脏值一样原样留在盘上；内存规范化是读取方的职责，
      // 迁移不得以此为理由整份重写（整表重建曾在名单漂移时于每次读取清掉覆盖）。
      Worker: SELECTION,
      "future-agent": SELECTION,
      broken: { providerId: "" },
    },
    pluginAgentModelSelectionOverrides: { "plugin:foo:bar": SELECTION, junk: "x" },
    builtInModelOverrides: { Worker: "legacy-model" },
    builtInThoughtLevelOverrides: { Worker: "high" },
  } as Parameters<typeof importSubagentStateSelections>[0];
  assert.deepEqual(importSubagentStateSelections(structuredClone(input)), input);
});

test("正式字段缺失时从遗留双 map 一次性创建：现役内置名翻译，废弃 Worker 键不导入且遗留字段保留", () => {
  // Worker 已废弃（docs/specs/team-mode.md）：遗留覆盖不翻译进正式字段。
  const next = importSubagentStateSelections({
    disabledAgentIds: [],
    builtInModelOverrides: {
      Worker: "zcode/glm-5",
      Explore: "inherit",
      "general-purpose": "custom:builtin%3Abigmodel:GLM-5.3-Flash",
    },
    builtInThoughtLevelOverrides: { Worker: "low" },
  } as Parameters<typeof importSubagentStateSelections>[0]);
  assert.deepEqual(next.builtInModelSelectionOverrides, {
    "general-purpose": { providerId: "bigmodel-api", modelId: "GLM-5.3-Flash" },
  });
  // 遗留字段与无关键保留不删，仅供旧版本回滚。
  assert.deepEqual(next.builtInModelOverrides, {
    Worker: "zcode/glm-5",
    Explore: "inherit",
    "general-purpose": "custom:builtin%3Abigmodel:GLM-5.3-Flash",
  });
  assert.deepEqual(next.disabledAgentIds, []);
});

test("导入是幂等的：对导入结果再跑一遍不再产生任何改动", () => {
  const first = importSubagentStateSelections({
    builtInModelOverrides: { Explore: "zcode/glm-5" },
  });
  assert.deepEqual(importSubagentStateSelections(structuredClone(first)), first);
});

test("插件正式字段同样一次性：存在即保留；缺失时只收 plugin: 前缀的遗留条目", () => {
  const kept = importSubagentStateSelections({
    pluginAgentModelSelectionOverrides: { "plugin:foo:bar": SELECTION, junk: "x" },
    pluginAgentModelOverrides: { "plugin:foo:bar": "legacy/model" },
  });
  assert.deepEqual(kept.pluginAgentModelSelectionOverrides, {
    "plugin:foo:bar": SELECTION,
    junk: "x",
  });

  const imported = importSubagentStateSelections({
    pluginAgentModelOverrides: {
      "plugin:foo:bar": "zcode/glm-5",
      "not-plugin": "zcode/glm-5",
    },
    pluginAgentThoughtLevelOverrides: { "plugin:foo:bar": "medium" },
  });
  assert.deepEqual(imported.pluginAgentModelSelectionOverrides, {
    "plugin:foo:bar": {
      providerId: "zcode",
      modelId: "glm-5",
      options: { reasoningLevel: "medium" },
    },
  });
});
