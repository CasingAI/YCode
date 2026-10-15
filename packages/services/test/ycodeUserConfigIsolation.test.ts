import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { getAppConfigDir, getYCodeAppConfigDir, setDataBaseDir } from "../src/paths.js";

const builtinFile = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ycode-config-isolation-"));
  setDataBaseDir(dir);
  await mkdir(getAppConfigDir(), { recursive: true });
  const runtime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: builtinFile,
    personalPollingIntervalMs: false,
    watch: false,
  });
  return {
    dir,
    legacyPath: join(getAppConfigDir(), "provider_config.json"),
    ycodePath: join(getYCodeAppConfigDir(), "provider_config.json"),
    runtime,
    async dispose() {
      runtime.dispose();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("YCode 默认 Provider 配置指向 .ycode，缺失时独立初始化且绝不读旧文件", async () => {
  const fixture = await setup();
  try {
    assert.equal(fixture.ycodePath, join(fixture.dir, ".ycode", "v2", "provider_config.json"));
    // 旧文件即使存在合法内容，也绝不能被读取。
    await writeFile(
      fixture.legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "legacy-only",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "legacy-key" },
                  api: { type: "openai-chat-completions", baseUrl: "https://legacy.example/v1" },
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
    );
    await fixture.runtime.start();
    const config = await fixture.runtime.configService.read();
    assert.equal(config.personalProviders.getRule("legacy-only"), undefined);
    // Repository 缺失时惰性返回空 overlay，首次保存才创建新文件。
    await assert.rejects(readFile(fixture.ycodePath, "utf8"), { code: "ENOENT" });
    await fixture.runtime.personalRepository.update((current) => ({ ...current }));
    const persisted = JSON.parse(await readFile(fixture.ycodePath, "utf8"));
    assert.equal(persisted.schemaVersion, 1);
    assert.deepEqual(persisted.config.providerConfigRules.providerRules, []);
    assert.match(await readFile(fixture.legacyPath, "utf8"), /legacy-only/);
  } finally {
    await fixture.dispose();
  }
});

test("新文件存在时只用新文件，旧文件后续修改不影响", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.start();
    const before = await fixture.runtime.configService.read();
    assert.deepEqual(before.personalProviders.toJSON(), []);
    await writeFile(
      fixture.legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
    );
    const second = createProviderConfigRuntime({
      zcodeBuiltinFilePath: builtinFile,
      personalPollingIntervalMs: false,
      watch: false,
    });
    try {
      await second.start();
      const config = await second.configService.read();
      assert.deepEqual(config.personalProviders.toJSON(), []);
    } finally {
      second.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});
