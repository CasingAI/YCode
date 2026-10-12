import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

// 子智能体组意图落盘/回填（docs/specs/model-group.md）：
// 写组即清具体模型、写具体即清组；list 回填组意图与覆盖。

const GROUP = { groupId: "model-group:free", groupNameSnapshot: "免费组" };
const SELECTION = { providerId: "zcode", modelId: "glm-5", options: { reasoningLevel: "high" } };

async function withHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "ycode-subagent-group-"));
  try {
    await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("写组即清具体模型：内置覆盖落盘后回填组意图", async () => {
  await withHome(async (homeDir) => {
    const service = createSubagentsService({ homeDir });
    await service.setBuiltInModelOverride({
      agentName: "general-purpose",
      modelSelection: SELECTION,
    });
    await service.setBuiltInModelOverride({
      agentName: "general-purpose",
      modelGroupIntent: GROUP,
    });
    const result = await service.list({ workspacePath: homeDir });
    const agent = result.agents.find((candidate) => candidate.name === "general-purpose");
    assert.deepEqual(agent?.modelGroupIntentOverride, GROUP);
    // 中文注释：写组必须清掉同名具体模型覆盖，否则启动裁决会读到两份意图。
    assert.equal(agent?.modelSelectionOverride, undefined);
  });
});

test("写具体即清组：覆盖回具体模型后组意图消失", async () => {
  await withHome(async (homeDir) => {
    const service = createSubagentsService({ homeDir });
    await service.setBuiltInModelOverride({
      agentName: "Explore",
      modelGroupIntent: GROUP,
    });
    await service.setBuiltInModelOverride({
      agentName: "Explore",
      modelSelection: SELECTION,
    });
    const result = await service.list({ workspacePath: homeDir });
    const agent = result.agents.find((candidate) => candidate.name === "Explore");
    assert.deepEqual(agent?.modelSelectionOverride, SELECTION);
    assert.equal(agent?.modelGroupIntentOverride, undefined);
  });
});

test("Worker 覆盖写入后能回填：读取迁移不得清掉正式内置名", async () => {
  await withHome(async (homeDir) => {
    const service = createSubagentsService({ homeDir });
    await service.setBuiltInModelOverride({
      agentName: "Worker",
      modelSelection: SELECTION,
    });
    const result = await service.list({ workspacePath: homeDir });
    const agent = result.agents.find((candidate) => candidate.name === "Worker");
    // 中文注释：list 会先跑存储导入；导入漏 Worker 时这里会回到继承默认。
    assert.deepEqual(agent?.modelSelectionOverride, SELECTION);
  });
});

test("跟随默认清两侧：两者缺席即删除覆盖", async () => {
  await withHome(async (homeDir) => {
    const service = createSubagentsService({ homeDir });
    await service.setBuiltInModelOverride({
      agentName: "general-purpose",
      modelGroupIntent: GROUP,
    });
    await service.setBuiltInModelOverride({ agentName: "general-purpose" });
    const result = await service.list({ workspacePath: homeDir });
    const agent = result.agents.find((candidate) => candidate.name === "general-purpose");
    assert.equal(agent?.modelGroupIntentOverride, undefined);
    assert.equal(agent?.modelSelectionOverride, undefined);
  });
});
