import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { ProviderRuntime } from "../src/model-provider/providerRuntime.js";

const builtinFile = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

test("模型草稿携带真实 Registry revision 保存图片能力；陈旧版本拒绝且不写盘", async () => {
  const home = await mkdtemp(join(tmpdir(), "ycode-model-revision-"));
  const path = join(home, ".ycode", "v2", "provider_config.json");
  const runtime = new ProviderRuntime({
    configRuntime: createProviderConfigRuntime({
      zcodeBuiltinFilePath: builtinFile,
      personalFilePath: path,
      personalPollingIntervalMs: false,
      watch: false,
    }),
  });
  try {
    await runtime.start();
    const created = await runtime.providerSettings.createPersonalProvider({
      providerName: "Test provider",
    });
    const providerId = created.providerId;
    const view = await runtime.providerSettings.addPersonalModel(providerId, "test-model", {});
    assert.ok(view.revision > 0);
    const draft = {
      providerId,
      originalModelId: "test-model",
      nextModelId: "test-model",
      personalConfig: { properties: { inputFormat: { supportsText: true, supportsImage: true } } },
      basedOnRevision: view.revision,
    };
    const saved = await runtime.providerSettings.savePersonalModelDraft(draft);
    const model = saved.providers
      .find((p) => p.providerId === providerId)
      ?.models.find((m) => m.modelId === "test-model");
    assert.equal(model?.personalExactConfig?.properties?.inputFormat?.supportsImage, true);
    const persisted = await readFile(path, "utf8");
    await runtime.providerSettings.addPersonalModel(providerId, "concurrent-model", {});
    const concurrent = await readFile(path, "utf8");
    assert.notEqual(concurrent, persisted);
    await assert.rejects(
      runtime.providerSettings.savePersonalModelDraft(draft),
      /Provider Settings revision conflict/,
    );
    assert.equal(await readFile(path, "utf8"), concurrent);
    const latest = await runtime.providerSettings.getView();
    const reloaded = await runtime.providerSettings.savePersonalModelDraft({
      ...draft,
      basedOnRevision: latest.revision,
    });
    assert.ok(reloaded.revision >= latest.revision);
  } finally {
    runtime.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
