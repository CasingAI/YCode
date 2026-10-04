import assert from "node:assert/strict";
import test from "node:test";
import { planStorageClean } from "../src/storage/domain/cleanPlan.js";
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  getStorageCleanScopes,
  type StorageCatalogContext,
} from "../src/storage/domain/storageCatalog.js";
import { createStorageUsageAccumulator } from "../src/storage/domain/usageAggregate.js";

const context: StorageCatalogContext = { rootId: "home", hasCustomDataBaseDir: false };

test("工具产物与临时缓存分属两类，插件缓存仍归运行时", () => {
  const classified = {
    artifact: classifyStoragePath("cli/artifacts/sess/tool.json", context).categoryId,
    exec: classifyStoragePath("cli/exec/out.txt", context).categoryId,
    workflow: classifyStoragePath("cli/sessions/sess/workflows/run.json", context).categoryId,
    agentOutput: classifyStoragePath("cli/agents/sess/agent/output.txt", context).categoryId,
    transcript: classifyStoragePath("cli/agents/sess/agent/transcript.jsonl", context).categoryId,
    checkpointPending: classifyStoragePath("v2/checkpoints/task/pending/a.bin", context).categoryId,
    imageCache: classifyStoragePath("cli/image-cache/sess/image-abc.png", context).categoryId,
    pdfCache: classifyStoragePath("cli/pdf-cache/sess/pdf-abc.pdf", context).categoryId,
    videoCache: classifyStoragePath("cli/video-cache/sess/video-abc.mp4", context).categoryId,
    clipboard: classifyStoragePath("clipboard/paste.png", context).categoryId,
    gitIndex: classifyStoragePath("git-checkpoint-index/index-1/index", context).categoryId,
    planCache: classifyStoragePath("v2/coding-plan-cache.json", context).categoryId,
    botsCache: classifyStoragePath("v2/bots-model-cache.json", context).categoryId,
    pluginCache: classifyStoragePath("cache/zcode-plugins-official/plugin/1.0.0/index.js", context)
      .categoryId,
  };

  assert.equal(classified.artifact, "toolOutputs");
  assert.equal(classified.exec, "toolOutputs");
  assert.equal(classified.workflow, "toolOutputs");
  assert.equal(classified.agentOutput, "toolOutputs");
  assert.equal(classified.transcript, "subagentTranscripts");
  assert.equal(classified.checkpointPending, "toolOutputs");
  assert.equal(classified.imageCache, "temporaryCaches");
  assert.equal(classified.pdfCache, "temporaryCaches");
  assert.equal(classified.videoCache, "temporaryCaches");
  assert.equal(classified.clipboard, "temporaryCaches");
  assert.equal(classified.gitIndex, "temporaryCaches");
  assert.equal(classified.planCache, "temporaryCaches");
  assert.equal(classified.botsCache, "temporaryCaches");
  assert.equal(classified.pluginCache, "runtimes");
});

test("临时缓存可直接清理，工具输出整类仍拒绝清理", () => {
  assert.equal(getStorageCategoryCleanability("temporaryCaches"), "safe");
  assert.equal(getStorageCategoryCleanability("toolOutputs"), "none");
  assert.equal(getStorageCleanScopes("toolOutputs").length, 0);
  const cacheScopes = getStorageCleanScopes("temporaryCaches");
  assert.ok(cacheScopes.some((scope) => scope.prefix === "cli/image-cache" && scope.recursive));
  assert.ok(cacheScopes.some((scope) => scope.prefix === "cli/video-cache" && scope.recursive));
  assert.ok(cacheScopes.some((scope) => scope.prefix === "v2" && !scope.recursive));
  assert.ok(!cacheScopes.some((scope) => scope.prefix === "cache"));
});

test("清理临时缓存不会带走工具产物或官方插件缓存", () => {
  const plan = planStorageClean({
    categoryId: "temporaryCaches",
    context,
    now: Date.now(),
    candidates: [
      { relativePath: "cli/image-cache/sess/a.png", bytes: 10, mtimeMs: 1 },
      { relativePath: "cli/artifacts/sess/tool.json", bytes: 20, mtimeMs: 1 },
      { relativePath: "cache/zcode-plugins-official/plugin/1.0.0/index.js", bytes: 30, mtimeMs: 1 },
    ],
  });
  assert.deepEqual(
    plan.targets.map((target) => target.relativePath),
    ["cli/image-cache/sess/a.png"],
  );
  assert.equal(plan.skippedCount, 2);

  const blocked = planStorageClean({
    categoryId: "toolOutputs",
    context,
    now: Date.now(),
    candidates: [{ relativePath: "cli/artifacts/sess/tool.json", bytes: 20, mtimeMs: 1 }],
  });
  assert.equal(blocked.targets.length, 0);
  assert.equal(blocked.skippedCount, 1);
});

test("扫描快照把两类占用分开，并带上各自的可清理性", () => {
  const accumulator = createStorageUsageAccumulator({
    id: "home",
    path: "/tmp/zcode-home",
    hasCustomDataBaseDir: false,
  });
  accumulator.add({ relativePath: "cli/artifacts/sess/tool.json", bytes: 100, mtimeMs: 1 });
  accumulator.add({ relativePath: "cli/image-cache/sess/a.png", bytes: 40, mtimeMs: 1 });
  const snapshot = accumulator.snapshot(null);
  const toolOutputs = snapshot.categories.find((category) => category.id === "toolOutputs");
  const temporaryCaches = snapshot.categories.find((category) => category.id === "temporaryCaches");
  assert.equal(toolOutputs?.bytes, 100);
  assert.equal(toolOutputs?.cleanability, "none");
  assert.equal(temporaryCaches?.bytes, 40);
  assert.equal(temporaryCaches?.cleanability, "safe");
});
