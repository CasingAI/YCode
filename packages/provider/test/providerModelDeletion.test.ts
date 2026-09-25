import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ModelConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigLayerSnapshot,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderConfigService,
  ProviderTemplate,
  ProviderTemplateMap,
  ZhipuAccountAccessConfig,
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
  type PersonalProviderConfigRepository,
  type ProviderModelMembership,
  type ProviderSource,
} from "../src/index.js";

const BUILTIN_URL = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
const ACCOUNT_PROVIDER_ID = "account:zai-individual-coding-plan";
const SHARED_MODEL_ID = "shared-model";

class StaticSource<T> implements ProviderSource<T> {
  readonly #snapshot: T;

  constructor(snapshot: T) {
    this.#snapshot = snapshot;
  }

  async read(): Promise<T> {
    return this.#snapshot;
  }

  onDidChange(): () => void {
    return () => undefined;
  }
}

class MemoryPersonalRepository implements PersonalProviderConfigRepository {
  readonly #listeners = new Set<(reason: string) => void>();
  #revision = 0;
  #snapshot: ProviderConfigLayerSnapshot;

  constructor(snapshot: Omit<ProviderConfigLayerSnapshot, "revision">) {
    this.#snapshot = Object.freeze({ ...snapshot, revision: "personal-0" });
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    return this.#snapshot;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async update(
    transform: (
      current: ProviderConfigLayerSnapshot,
    ) => Omit<ProviderConfigLayerSnapshot, "revision">,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#revision += 1;
    this.#snapshot = Object.freeze({
      ...transform(this.#snapshot),
      revision: `personal-${this.#revision}`,
    });
    for (const listener of this.#listeners) listener("test");
    return this.#snapshot;
  }
}

function createService() {
  const builtin: ProviderConfigLayerSnapshot = {
    revision: "builtin-1",
    providers: ProviderConfigMap.empty(),
    providerTemplates: new ProviderTemplateMap([
      [
        "shared-template",
        new ProviderTemplate({
          templateId: "shared-template",
          templateNameMap: { "en-US": "Shared" },
          config: new ProviderConfig({ builtinModelIds: [SHARED_MODEL_ID] }),
        }),
      ],
    ]),
    models: ModelConfigRules.empty(),
  };
  const repository = new MemoryPersonalRepository({
    providers: new ProviderConfigMap([
      {
        providerId: "provider-a",
        providerName: "Provider A",
        templateId: "shared-template",
        config: new ProviderConfig({
          group: "standard-personal",
          personalModelIds: ["personal-a"],
          modelOrder: ["personal-a"],
        }),
      },
      {
        providerId: "provider-b",
        providerName: "Provider B",
        templateId: "shared-template",
        config: new ProviderConfig({
          group: "standard-personal",
          personalModelIds: [],
          modelOrder: [],
        }),
      },
    ]),
    models: ModelConfigRules.empty(),
    providerOrder: ["provider-a", "provider-b"],
  });
  return {
    repository,
    service: new ProviderConfigService({
      zcodeBuiltinSource: new StaticSource(builtin),
      personalRepository: repository,
    }),
  };
}

async function membership(
  providerId: string,
  repository: MemoryPersonalRepository,
): Promise<ProviderModelMembership> {
  const current = await repository.read();
  return {
    providerId,
    inheritedModelIds: [SHARED_MODEL_ID],
    personalRevision: current.revision,
    assertCurrent: () => {
      void repository;
    },
  };
}

test("删除内置模型只写入当前 providerId 的墓碑", async () => {
  const { repository, service } = createService();
  await service.deletePersonalModel(
    "provider-a",
    SHARED_MODEL_ID,
    await membership("provider-a", repository),
  );

  const providers = (await repository.read()).providers;
  assert.deepEqual(providers.get("provider-a")?.excludedModelIds, [SHARED_MODEL_ID]);
  // 另一个 Provider 的同名模型不受影响
  assert.equal(providers.get("provider-b")?.excludedModelIds, undefined);
});

test("删除后内置成员解析不再包含该模型，同名添加不会被判重挡住", async () => {
  const { repository, service } = createService();

  // 删除时不传 membership，走 resolveProviderBuiltinModelIds 回退分支
  await service.deletePersonalModel("provider-a", SHARED_MODEL_ID);
  assert.deepEqual((await repository.read()).providers.get("provider-a")?.excludedModelIds, [
    SHARED_MODEL_ID,
  ]);

  // 该 ID 在上层看来已不存在：用同一个 ID 再次添加不会命中"Model 已存在"
  await service.addPersonalModel("provider-a", SHARED_MODEL_ID, ModelConfig.empty(), undefined);
  const afterAdd = await repository.read();
  assert.deepEqual(afterAdd.providers.get("provider-a")?.personalModelIds, [
    "personal-a",
    SHARED_MODEL_ID,
  ]);

  // 墓碑只压制内置声明，个人模型不受影响，所以它作为 personal 正常出现在解析结果里
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: ProviderConfigMap.empty(),
    zcodeBuiltinProviderTemplates: new ProviderTemplateMap([
      [
        "shared-template",
        new ProviderTemplate({
          templateId: "shared-template",
          templateNameMap: { "en-US": "Shared" },
          config: new ProviderConfig({ builtinModelIds: [SHARED_MODEL_ID] }),
        }),
      ],
    ]),
    personalProviders: afterAdd.providers,
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: afterAdd.models,
    accountProviders: ProviderConfigMap.empty(),
  });
  const resolved = resolution.resolvedProviders.find((item) => item.providerId === "provider-a");
  assert.ok(resolved);
  assert.equal(
    resolved.models.find((model) => model.modelId === SHARED_MODEL_ID)?.source,
    "personal",
  );
});

test("删除 Personal Model 写入墓碑并清理成员与排序", async () => {
  const { repository, service } = createService();
  await service.deletePersonalModel(
    "provider-a",
    "personal-a",
    await membership("provider-a", repository),
  );

  const provider = (await repository.read()).providers.get("provider-a");
  assert.deepEqual(provider?.excludedModelIds, ["personal-a"]);
  assert.deepEqual(provider?.personalModelIds, []);
  assert.deepEqual(provider?.modelOrder, [SHARED_MODEL_ID]);
});

test("Provider 改名、启停与字段保存都不会清空墓碑", async () => {
  const { repository, service } = createService();
  await service.deletePersonalModel(
    "provider-a",
    SHARED_MODEL_ID,
    await membership("provider-a", repository),
  );

  await service.savePersonalProviderOverlay(
    "provider-a",
    new ProviderConfig({ group: "standard-personal", visibility: "hidden" }),
    await membership("provider-a", repository),
    { providerName: "Provider A renamed", enabled: false },
  );

  const provider = (await repository.read()).providers.getRule("provider-a");
  assert.deepEqual(provider?.config.excludedModelIds, [SHARED_MODEL_ID]);
  assert.equal(provider?.config.visibility, "hidden");
  assert.equal(provider?.providerName, "Provider A renamed");
  assert.equal(provider?.enabled, false);
});

test("Provider 删除会移除整条记录，墓碑随之消失", async () => {
  const { repository, service } = createService();
  await service.deletePersonalModel(
    "provider-a",
    SHARED_MODEL_ID,
    await membership("provider-a", repository),
  );

  await service.deletePersonalProvider("provider-a");
  const providers = (await repository.read()).providers;
  assert.equal(providers.get("provider-a"), undefined);
  assert.deepEqual(providers.get("provider-b")?.excludedModelIds, undefined);
});

test("模型排序不会影响墓碑", async () => {
  const { repository, service } = createService();
  await service.deletePersonalModel(
    "provider-a",
    SHARED_MODEL_ID,
    await membership("provider-a", repository),
  );

  await service.reorderPersonalModels(
    "provider-a",
    ["personal-a"],
    await membership("provider-a", repository),
  );

  const provider = (await repository.read()).providers.get("provider-a");
  assert.deepEqual(provider?.excludedModelIds, [SHARED_MODEL_ID]);
  assert.deepEqual(provider?.modelOrder, [SHARED_MODEL_ID, "personal-a"]);
});

test("过期的 membership 被拒绝，不会写入墓碑", async () => {
  const { repository, service } = createService();
  const stale = await membership("provider-a", repository);
  // 先做一次写入让 revision 前进，stale 上的 revision 随即过期
  await service.deletePersonalModel(
    "provider-b",
    SHARED_MODEL_ID,
    await membership("provider-b", repository),
  );

  await assert.rejects(
    service.deletePersonalModel("provider-a", SHARED_MODEL_ID, stale),
    /membership revision conflict/,
  );
  assert.equal((await repository.read()).providers.get("provider-a")?.excludedModelIds, undefined);
});

test("删除不存在的模型被拒绝", async () => {
  const { repository, service } = createService();
  await assert.rejects(
    service.deletePersonalModel(
      "provider-a",
      "never-existed",
      await membership("provider-a", repository),
    ),
    /Model 不存在/,
  );
});

test("Built-in Source 规则不能声明用户级墓碑", () => {
  assert.throws(() =>
    parseZCodeBuiltinProviderConfigRules({
      templateRules: [],
      providerRules: [
        {
          providerId: "builtin-provider",
          config: { excludedModelIds: [SHARED_MODEL_ID] },
        },
      ],
    }),
  );
});

async function loadResolverInput(excludedModelId?: string) {
  const release = JSON.parse(await readFile(BUILTIN_URL, "utf8")) as {
    config: {
      providerConfigRules: unknown;
      modelConfigRules: unknown;
    };
  };
  const builtin = {
    providers: parseZCodeBuiltinProviderConfigRules(release.config.providerConfigRules).providers,
    models: parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules),
  };
  return {
    zcodeBuiltinProviders: builtin.providers,
    zcodeBuiltinProviderTemplates: undefined,
    accountProviders: new ProviderConfigMap([
      [
        ACCOUNT_PROVIDER_ID,
        new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
      ],
    ]),
    personalProviders: new ProviderConfigMap([
      {
        providerId: ACCOUNT_PROVIDER_ID,
        config: new ProviderConfig(excludedModelId ? { excludedModelIds: [excludedModelId] } : {}),
      },
    ]),
    zcodeBuiltinModelRules: builtin.models,
    personalModels: ModelConfigRules.empty(),
    accountStates: {
      [ACCOUNT_PROVIDER_ID]: {
        availability: "available" as const,
        entitled: true,
        current: true,
      },
    },
  };
}

test("Resolver 在设置投影和 Registry 之前排除已删除模型", async () => {
  // 前置：未删除时该模型确实存在，避免断言退化为空检查
  const baseline = new ProviderConfigResolver().resolve(await loadResolverInput());
  const baselineProvider = baseline.resolvedProviders.find(
    (item) => item.providerId === ACCOUNT_PROVIDER_ID,
  );
  assert.ok(baselineProvider);
  assert.equal(
    baselineProvider.models.some((model) => model.modelId === "GLM-5.3-Flash"),
    true,
  );

  const input = await loadResolverInput("GLM-5.3-Flash");
  const resolution = new ProviderConfigResolver().resolve(input);
  const provider = resolution.resolvedProviders.find(
    (item) => item.providerId === ACCOUNT_PROVIDER_ID,
  );
  const registryProvider = resolution.registryProviders.find(
    (item) => item.providerId === ACCOUNT_PROVIDER_ID,
  );

  assert.ok(provider);
  assert.equal(
    provider.models.some((model) => model.modelId === "GLM-5.3-Flash"),
    false,
  );
  assert.ok(registryProvider);
  assert.equal(
    registryProvider.models.some((model) => model.modelId === "GLM-5.3-Flash"),
    false,
  );
  assert.equal(
    registryProvider.models.some((model) => model.modelId === "GLM-5.3"),
    true,
  );
});
