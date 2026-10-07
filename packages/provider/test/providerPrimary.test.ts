import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderConfigService,
  parsePersonalProviderConfigMap,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "../src/index.js";

// Primary 展示标记（docs/specs/provider-primary.md）：
// 缺省为关、overlay 合并沿用 enabled 语义、不参与可执行判定。

function resolveWithPersonal(
  personalProviders: ProviderConfigMap,
  builtinProviders = ProviderConfigMap.empty(),
) {
  return new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: builtinProviders,
    personalProviders,
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: ProviderConfigMap.empty(),
  });
}

test("缺省为关：未写 isPrimary 的 Provider 解析为 false", () => {
  const resolution = resolveWithPersonal(
    new ProviderConfigMap([
      { providerId: "p1", config: new ProviderConfig({ group: "standard-personal" }) },
    ]),
  );
  const provider = resolution.resolvedProviders.find((item) => item.providerId === "p1");
  assert.ok(provider);
  assert.equal(provider.isPrimary, false);
});

test("个人层可打开 Primary：overlay 合并不是整条替换", () => {
  const builtin = new ProviderConfigMap([
    {
      providerId: "p1",
      providerName: "Provider One",
      config: new ProviderConfig({ group: "standard-personal" }),
    },
  ]);
  const personal = new ProviderConfigMap([
    { providerId: "p1", isPrimary: true, config: new ProviderConfig() },
  ]);
  const resolution = resolveWithPersonal(personal, builtin);
  const provider = resolution.resolvedProviders.find((item) => item.providerId === "p1");
  assert.ok(provider);
  assert.equal(provider.isPrimary, true);
  assert.equal(provider.providerName, "Provider One");
});

test("Primary 不改变可执行性：标记打开也不发布空模型 Provider", () => {
  const resolution = resolveWithPersonal(
    new ProviderConfigMap([
      {
        providerId: "p1",
        isPrimary: true,
        config: new ProviderConfig({ group: "standard-personal" }),
      },
    ]),
  );
  const provider = resolution.resolvedProviders.find((item) => item.providerId === "p1");
  assert.ok(provider);
  assert.equal(provider.isPrimary, true);
  assert.equal(
    resolution.registryProviders.some((item) => item.providerId === "p1"),
    false,
  );
});

class StaticSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #snapshot: ProviderConfigLayerSnapshot;
  constructor(snapshot: ProviderConfigLayerSnapshot) {
    this.#snapshot = snapshot;
  }
  async read(): Promise<ProviderConfigLayerSnapshot> {
    return this.#snapshot;
  }
  onDidChange(): () => void {
    return () => undefined;
  }
}

class MemoryPersonalRepository {
  #revision = 0;
  #snapshot: ProviderConfigLayerSnapshot;
  constructor(snapshot: Omit<ProviderConfigLayerSnapshot, "revision">) {
    this.#snapshot = Object.freeze({ ...snapshot, revision: "personal-0" });
  }
  async read(): Promise<ProviderConfigLayerSnapshot> {
    return this.#snapshot;
  }
  onDidChange(): () => void {
    return () => undefined;
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
    return this.#snapshot;
  }
}

test("保存 metadata 稀疏补丁只写 isPrimary，不碰 access 与 enabled", async () => {
  const builtin: ProviderConfigLayerSnapshot = {
    revision: "builtin-1",
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  };
  const repository = new MemoryPersonalRepository({
    providers: new ProviderConfigMap([
      {
        providerId: "p1",
        providerName: "P1",
        enabled: true,
        config: new ProviderConfig({ group: "standard-personal" }),
      },
    ]),
    models: ModelConfigRules.empty(),
    providerOrder: ["p1"],
  });
  const service = new ProviderConfigService({
    zcodeBuiltinSource: new StaticSource(builtin),
    personalRepository: repository as never,
  });

  await service.savePersonalProviderOverlay("p1", new ProviderConfig(), undefined, {
    isPrimary: true,
  });

  const rule = (await repository.read()).providers.getRule("p1");
  assert.equal(rule?.isPrimary, true);
  // 未随补丁提交的 enabled 沿用旧值，不被缺省覆盖。
  assert.equal(rule?.enabled, true);
});

test("个人覆盖层 JSON 往返保留 isPrimary：重启后标记仍在", () => {
  const stored = new ProviderConfigMap([
    {
      providerId: "p1",
      providerName: "P1",
      isPrimary: true,
      config: new ProviderConfig({ group: "standard-personal" }),
    },
  ]);
  // toJSON 写盘、parsePersonalProviderConfigMap 读盘：规则外层字段随 overlay 自动跟随。
  const reloaded = parsePersonalProviderConfigMap({ providerRules: stored.toJSON() });
  assert.equal(reloaded.getRule("p1")?.isPrimary, true);
});
