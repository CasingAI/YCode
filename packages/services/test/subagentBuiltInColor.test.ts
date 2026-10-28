import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

// 内置子智能体身份色事实源（docs/specs/built-in-subagent-identity-color.md）：
// general-purpose 显示名「通用」= red，Explore 显示名「探索」= green。
// 该值同时被 CLI core 的 profile 工厂镜像、被 UI hash 兜底（resolveSubagentColorFromName）
// 对齐，改这里必须同步另两处，否则 store 未就绪时会闪成 hash 色。

async function withHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "ycode-subagent-color-"));
  try {
    await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("内置身份色：通用为 red、探索为 green", async () => {
  await withHome(async (homeDir) => {
    const service = createSubagentsService({ homeDir });
    const result = await service.list({ workspacePath: homeDir });
    const generalPurpose = result.agents.find(
      (candidate) => candidate.name === "general-purpose",
    );
    const explore = result.agents.find((candidate) => candidate.name === "Explore");
    assert.equal(generalPurpose?.scope, "built-in");
    assert.equal(explore?.scope, "built-in");
    assert.equal(generalPurpose?.color, "red");
    assert.equal(explore?.color, "green");
  });
});
