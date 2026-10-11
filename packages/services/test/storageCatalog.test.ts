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
  assert.equal(classified.exec, "commandOutputs");
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

test("命令输出从工具输出拆出可清理，剩余工具输出对话框内可选清理", () => {
  assert.equal(getStorageCategoryCleanability("temporaryCaches"), "safe");
  assert.equal(getStorageCategoryCleanability("commandOutputs"), "safe");
  assert.equal(getStorageCategoryCleanability("toolOutputs"), "safe");
  const execScopes = getStorageCleanScopes("commandOutputs");
  assert.ok(execScopes.some((scope) => scope.prefix === "cli/exec" && scope.recursive));
  const toolScopes = getStorageCleanScopes("toolOutputs");
  assert.ok(toolScopes.some((scope) => scope.prefix === "cli/artifacts" && scope.recursive));
  assert.ok(!toolScopes.some((scope) => scope.prefix === "cli/exec"));
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

  const toolPlan = planStorageClean({
    categoryId: "toolOutputs",
    context,
    now: Date.now(),
    candidates: [{ relativePath: "cli/artifacts/sess/tool.json", bytes: 20, mtimeMs: 1 }],
  });
  assert.deepEqual(
    toolPlan.targets.map((target) => target.relativePath),
    ["cli/artifacts/sess/tool.json"],
  );
  assert.equal(toolPlan.skippedCount, 0);
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
  assert.equal(toolOutputs?.cleanability, "safe");
  assert.equal(temporaryCaches?.bytes, 40);
  assert.equal(temporaryCaches?.cleanability, "safe");
});

const DAY_MS = 24 * 60 * 60 * 1000;

test("命令完整输出按年龄过滤：7天前只删更老的文件", () => {
  const now = Date.now();
  const plan = planStorageClean({
    categoryId: "commandOutputs",
    context,
    now,
    olderThanMs: 7 * DAY_MS,
    candidates: [
      { relativePath: "cli/exec/sess_old/call_1-stdout.log", bytes: 100, mtimeMs: now - 30 * DAY_MS },
      { relativePath: "cli/exec/sess_old/call_2-stdout.log", bytes: 50, mtimeMs: now - 8 * DAY_MS },
      { relativePath: "cli/exec/sess_new/call_1-stdout.log", bytes: 60, mtimeMs: now - 2 * DAY_MS },
    ],
  });
  assert.deepEqual(
    plan.targets.map((target) => target.relativePath),
    ["cli/exec/sess_old/call_1-stdout.log", "cli/exec/sess_old/call_2-stdout.log"],
  );
  assert.equal(plan.skippedCount, 1);
});

test("命令完整输出选全部仍跳过24小时内有写入的会话目录", () => {
  const now = Date.now();
  const plan = planStorageClean({
    categoryId: "commandOutputs",
    context,
    now,
    candidates: [
      { relativePath: "cli/exec/sess_old/call_1-stdout.log", bytes: 100, mtimeMs: now - 30 * DAY_MS },
      { relativePath: "cli/exec/sess_hot/call_1-stdout.log", bytes: 200, mtimeMs: now - 30 * DAY_MS },
      { relativePath: "cli/exec/sess_hot/call_2-stdout.log", bytes: 50, mtimeMs: now - 60 * 60 * 1000 },
    ],
  });
  assert.deepEqual(
    plan.targets.map((target) => target.relativePath),
    ["cli/exec/sess_old/call_1-stdout.log"],
  );
  assert.equal(plan.skippedCount, 2);
});

test("日志选全部仍保留当天，选30天前只删更老的", () => {
  const now = Date.now();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayNoon = startOfToday.getTime() + 12 * 60 * 60 * 1000;
  const safeToday = todayNoon <= now ? todayNoon : startOfToday.getTime();
  const all = planStorageClean({
    categoryId: "logs",
    context,
    now,
    candidates: [
      { relativePath: "v2/logs/old.log", bytes: 10, mtimeMs: now - 40 * DAY_MS },
      { relativePath: "v2/logs/today.log", bytes: 20, mtimeMs: safeToday },
    ],
  });
  assert.deepEqual(
    all.targets.map((target) => target.relativePath),
    ["v2/logs/old.log"],
  );
  assert.equal(all.skippedCount, 1);

  const range = planStorageClean({
    categoryId: "logs",
    context,
    now,
    olderThanMs: 30 * DAY_MS,
    candidates: [
      { relativePath: "v2/logs/old.log", bytes: 10, mtimeMs: now - 40 * DAY_MS },
      { relativePath: "v2/logs/recent.log", bytes: 20, mtimeMs: now - 10 * DAY_MS },
    ],
  });
  assert.deepEqual(
    range.targets.map((target) => target.relativePath),
    ["v2/logs/old.log"],
  );
  assert.equal(range.skippedCount, 1);
});

test("会话库配置运行时仍拒绝清理", () => {
  for (const categoryId of ["sessionStore", "runtimes", "config", "other"] as const) {
    const plan = planStorageClean({
      categoryId,
      context,
      now: Date.now(),
      candidates: [{ relativePath: "v2/sessions/a.json", bytes: 10, mtimeMs: 1 }],
    });
    assert.equal(plan.targets.length, 0);
    assert.equal(plan.skippedCount, 1);
    assert.equal(getStorageCleanScopes(categoryId).length, 0);
  }
});

test("沙盒 LocalStorage 单独成类：按会话目录聚合、可清理", () => {
  // 分类：cli/sandbox 下的文件归 sandbox，不进工具产物。
  assert.equal(
    classifyStoragePath("cli/sandbox/sess_abc/local-storage.json", context).categoryId,
    "sandbox",
  );
  assert.equal(
    classifyStoragePath("cli/sandbox/sess_abc/local-storage.json", context).entryKey,
    "cli/sandbox/sess_abc",
  );
  assert.equal(getStorageCategoryCleanability("sandbox"), "safe");
  const scopes = getStorageCleanScopes("sandbox");
  assert.ok(scopes.some((scope) => scope.prefix === "cli/sandbox" && scope.recursive));
  // 扫描快照：两会话分开计占用，下钻明细按会话聚合。
  const accumulator = createStorageUsageAccumulator({
    id: "home",
    path: "/tmp/zcode-home",
    hasCustomDataBaseDir: false,
  });
  accumulator.add({ relativePath: "cli/sandbox/sess_a/local-storage.json", bytes: 100, mtimeMs: 1 });
  accumulator.add({ relativePath: "cli/sandbox/sess_b/local-storage.json", bytes: 50, mtimeMs: 1 });
  accumulator.add({ relativePath: "cli/artifacts/sess/tool.json", bytes: 1000, mtimeMs: 1 });
  const snapshot = accumulator.snapshot(null);
  const sandbox = snapshot.categories.find((category) => category.id === "sandbox");
  assert.equal(sandbox?.bytes, 150);
  assert.equal(sandbox?.cleanability, "safe");
  const keys = (sandbox?.entries ?? []).map((entry) => entry.relativePath).sort();
  assert.deepEqual(keys, ["cli/sandbox/sess_a", "cli/sandbox/sess_b"]);
  // 工具产物不混入沙盒。
  const toolOutputs = snapshot.categories.find((category) => category.id === "toolOutputs");
  assert.equal(toolOutputs?.bytes, 1000);
});

test("沙盒按 entryKeys 只清选中会话：未选中不动", () => {
  const now = Date.now();
  const candidates = [
    { relativePath: "cli/sandbox/sess_a/local-storage.json", bytes: 100, mtimeMs: 1 },
    { relativePath: "cli/sandbox/sess_b/local-storage.json", bytes: 50, mtimeMs: 1 },
  ];
  const plan = planStorageClean({
    categoryId: "sandbox",
    candidates,
    context,
    now,
    entryKeys: ["cli/sandbox/sess_a"],
  });
  assert.deepEqual(
    plan.targets.map((target) => target.relativePath),
    ["cli/sandbox/sess_a/local-storage.json"],
  );
  assert.equal(plan.skippedCount, 1);
});
