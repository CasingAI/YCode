import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSubagentsService } from "../src/subagents/subagentsService.js";
import {
  resolveSubagentStateFile,
  resolveYCodeSubagentStateFile,
  resolveZCodeStorageRoot,
} from "../src/subagents/subagentStorage.js";

test("默认子代理状态新路径指向 .ycode，旧文件原样保留但不作为导入源", async () => {
  const home = await mkdtemp(join(tmpdir(), "ycode-subagent-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const storageRoot = await resolveZCodeStorageRoot({ homeDir: home });
    assert.equal(storageRoot, join(home, ".zcode"));
    assert.equal(
      await resolveSubagentStateFile({ homeDir: home }),
      join(home, ".ycode", "v2", "agents-state.json"),
    );
    assert.equal(
      await resolveYCodeSubagentStateFile({ homeDir: home }),
      join(home, ".ycode", "v2", "agents-state.json"),
    );
    const legacyPath = join(storageRoot, "v2", "agents-state.json");
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        builtInModelSelectionOverrides: {
          Worker: { providerId: "custom", modelId: "model-a" },
        },
        pluginAgentModelSelectionOverrides: {},
        builtInModelGroupIntentOverrides: {},
        pluginAgentModelGroupIntentOverrides: {},
        disabledAgentIds: [],
      }),
    );
    const legacy = await readFile(legacyPath, "utf8");
    const service = createSubagentsService({ homeDir: home });
    await service.prepareRuntimeState();
    const result = await service.list({ workspacePath: home });
    assert.equal(
      result.agents.find((agent) => agent.name === "Worker")?.modelSelectionOverride,
      undefined,
    );
    await service.setBuiltInModelOverride({
      agentName: "Worker",
      modelSelection: { providerId: "new-provider", modelId: "new-model" },
    });
    const stored = JSON.parse(
      await readFile(join(home, ".ycode", "v2", "agents-state.json"), "utf8"),
    );
    assert.equal(stored.builtInModelSelectionOverrides.Worker.providerId, "new-provider");
    assert.equal(await readFile(legacyPath, "utf8"), legacy);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("自定义 storage.dir 下的新路径复用同一解析，不改整个 storage root", async () => {
  const home = await mkdtemp(join(tmpdir(), "ycode-subagent-custom-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const customRoot = join(home, "custom-root");
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({ storage: { dir: customRoot } }),
    );
    assert.equal(await resolveZCodeStorageRoot({ homeDir: home }), customRoot);
    assert.equal(
      await resolveSubagentStateFile({ homeDir: home }),
      join(customRoot, ".ycode", "v2", "agents-state.json"),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
