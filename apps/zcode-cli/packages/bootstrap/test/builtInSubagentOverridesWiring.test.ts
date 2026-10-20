// 内置子智能体覆盖表接线（docs/specs/model-group.md / docs/specs/bare-worker.md）：
// agents-state.json 是内置覆盖表的唯一写入路径，CLI 启动时读盘后必须把组意图覆盖与
// 具体模型覆盖**一起**交给 runtime config。漏传任一侧，子会话就拿不到组意图，
// 表现为静默继承父模型（父模型 + 父档位），设置页却仍显示已选组。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfig } from "@zcode/adapters/config";
import type { ModelGroupIntent, ModelSelection } from "@zcode/shared";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";
import type { ZCodeAppOptions } from "../src/app/types.js";

const createAppSource = readFileSync(new URL("../src/app/create-app.ts", import.meta.url), "utf8");

const GROUP_INTENT: ModelGroupIntent = {
  groupId: "model-group:fast",
  groupNameSnapshot: "快速模型",
};
const SELECTION: ModelSelection = { providerId: "zcode", modelId: "glm-5" };

function createOptions(): ZCodeAppOptions {
  return {
    // Registry 只用于解析初始模型选择，这里给空名单即可。
    providerRegistry: {
      getView: () => ({ revision: 1, providers: [] }),
      getProvider: () => undefined,
      getModel: () => undefined,
      validateSelection: () => ({ ok: false, reason: "model-not-found" }),
      onDidChange: () => () => {},
    },
    env: {},
  } as unknown as ZCodeAppOptions;
}

test("create-app 必须把组意图覆盖与具体模型覆盖一起交给 runtime config", () => {
  const start = createAppSource.indexOf("resolveAppRuntimeConfig({");
  assert.notEqual(start, -1, "找不到 resolveAppRuntimeConfig 调用");
  const end = createAppSource.indexOf("});", start);
  assert.notEqual(end, -1, "resolveAppRuntimeConfig 调用没有闭合");
  const block = createAppSource.slice(start, end);
  assert.ok(
    block.includes("builtInSubagentModelSelectionOverrides"),
    "具体模型覆盖必须进 runtime config",
  );
  assert.ok(
    block.includes("builtInSubagentModelGroupIntentOverrides"),
    "组意图覆盖必须与具体模型覆盖一起进 runtime config，否则子会话继承父模型",
  );
});

test("resolveAppRuntimeConfig 把两份内置覆盖表都放进 runtime config", () => {
  const workingDirectory = join(tmpdir(), "zcode-built-in-overrides");
  const configResult = createConfig({
    env: {},
    workingDirectory,
    skipUserConfig: true,
  });
  const { runtimeConfig } = resolveAppRuntimeConfig({
    cliStorageRoot: join(workingDirectory, ".zcode-cli"),
    sandboxStorageRoot: join(workingDirectory, ".zcode-sandbox"),
    configResult,
    options: createOptions(),
    builtInSubagentModelSelectionOverrides: {
      "general-purpose": SELECTION,
      Explore: SELECTION,
      Worker: SELECTION,
    },
    builtInSubagentModelGroupIntentOverrides: {
      "general-purpose": GROUP_INTENT,
      Explore: GROUP_INTENT,
      Worker: GROUP_INTENT,
    },
    subagentOutputRootDir: join(workingDirectory, "agents"),
    storageRoot: workingDirectory,
    workingDirectory,
  });
  assert.deepEqual(runtimeConfig.subagents?.builtInModelSelectionOverrides, {
    "general-purpose": SELECTION,
    Explore: SELECTION,
    Worker: SELECTION,
  });
  assert.deepEqual(runtimeConfig.subagents?.builtInModelGroupIntentOverrides, {
    "general-purpose": GROUP_INTENT,
    Explore: GROUP_INTENT,
    Worker: GROUP_INTENT,
  });
});
