import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_DISPLAY_MODES,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderConfigService,
  ProviderRegistry,
  parsePersonalProviderConfigMap,
  projectModelSelectionProviderView,
  resolveProviderDisplayMode,
  type Provider,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "../src/index.js";

// 展示权重（docs/specs/provider-primary.md）：
// isPrimary 旧盘只读兼容、displayMode 三态新写入、overlay 合并沿用 enabled 语义、不参与可执行判定。

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

// proxyMode（docs/specs/plugin-cli-proxy-binary.md「上游代理」）：与 isPrimary 同层的
// Provider 级偏好，resolver 透传给 Host 做上游出口裁决，未写视为未设置。

test("proxyMode：个人层写入后经 resolver 透传，未写保持 undefined", () => {
  const personal = new ProviderConfigMap([
    { providerId: "cliproxy-codex", proxyMode: "proxy", config: new ProviderConfig({ group: "standard-personal" }) },
    { providerId: "plain", config: new ProviderConfig({ group: "standard-personal" }) },
  ]);
  const resolution = resolveWithPersonal(personal);
  const cliproxy = resolution.resolvedProviders.find((item) => item.providerId === "cliproxy-codex");
  assert.ok(cliproxy);
  assert.equal(cliproxy.proxyMode, "proxy");
  const plain = resolution.resolvedProviders.find((item) => item.providerId === "plain");
  assert.ok(plain);
  assert.equal(plain.proxyMode, undefined);
});

// ── displayMode 三态展示权重（docs/specs/provider-primary.md）──
// 新写入只写 displayMode；旧盘 isPrimary 只读派生：
// displayMode 已写 → 用它；未写但 isPrimary true → expanded；都没有 → submenu。

test("schema：displayMode 接受三值，非法值被 strict schema 拒绝", () => {
  const base = { providerId: "p1", config: { group: "standard-personal" } };
  for (const displayMode of PROVIDER_DISPLAY_MODES) {
    const parsed = parsePersonalProviderConfigMap({
      providerRules: [{ ...base, displayMode }],
    });
    assert.equal(parsed.getRule("p1")?.displayMode, displayMode);
  }
  assert.throws(() =>
    parsePersonalProviderConfigMap({
      providerRules: [{ ...base, displayMode: "collapsed" }],
    }),
  );
});

test("派生规则：displayMode 优先于 isPrimary；旧 isPrimary true 派生 expanded；都没有派生 submenu", () => {
  assert.equal(resolveProviderDisplayMode({ displayMode: "other", isPrimary: true }), "other");
  assert.equal(resolveProviderDisplayMode({ displayMode: "submenu", isPrimary: true }), "submenu");
  assert.equal(resolveProviderDisplayMode({ isPrimary: true }), "expanded");
  assert.equal(resolveProviderDisplayMode({ isPrimary: false }), "submenu");
  assert.equal(resolveProviderDisplayMode({}), "submenu");
});

test("overlay 合并：个人层 displayMode 覆盖内置层，未写沿用旧值", () => {
  const builtin = new ProviderConfigMap([
    {
      providerId: "p1",
      displayMode: "expanded",
      config: new ProviderConfig({ group: "standard-personal" }),
    },
  ]);
  assert.equal(
    builtin
      .overlay(
        new ProviderConfigMap([
          { providerId: "p1", displayMode: "other", config: new ProviderConfig() },
        ]),
      )
      .getRule("p1")?.displayMode,
    "other",
  );
  assert.equal(
    builtin
      .overlay(
        new ProviderConfigMap([{ providerId: "p1", config: new ProviderConfig() }]),
      )
      .getRule("p1")?.displayMode,
    "expanded",
  );
});

test("resolver 投影：displayMode 显式透传，旧 isPrimary 派生 expanded，缺省 submenu", () => {
  const personal = new ProviderConfigMap([
    {
      providerId: "p-explicit",
      displayMode: "other",
      config: new ProviderConfig({ group: "standard-personal" }),
    },
    {
      providerId: "p-legacy",
      isPrimary: true,
      config: new ProviderConfig({ group: "standard-personal" }),
    },
    { providerId: "p-default", config: new ProviderConfig({ group: "standard-personal" }) },
  ]);
  const resolution = resolveWithPersonal(personal);
  assert.equal(
    resolution.resolvedProviders.find((item) => item.providerId === "p-explicit")?.displayMode,
    "other",
  );
  assert.equal(
    resolution.resolvedProviders.find((item) => item.providerId === "p-legacy")?.displayMode,
    "expanded",
  );
  assert.equal(
    resolution.resolvedProviders.find((item) => item.providerId === "p-default")?.displayMode,
    "submenu",
  );
});

test("registry/facade 投影：冻结视图与 ModelSelection 投影带出有效 displayMode", () => {
  // freezeView 与 ModelSelection 投影只读这些字段；config 需满足序列化的最小形状。
  const providers = [
    {
      providerId: "p-explicit",
      isPrimary: true,
      displayMode: "other",
      models: [],
      config: { access: { type: "api-key" }, api: { type: "openai-chat-completions" } },
    },
    {
      providerId: "p-legacy",
      isPrimary: true,
      models: [],
      config: { access: { type: "api-key" }, api: { type: "openai-chat-completions" } },
    },
    {
      providerId: "p-default",
      isPrimary: false,
      models: [],
      config: { access: { type: "api-key" }, api: { type: "openai-chat-completions" } },
    },
  ] as unknown as Provider[];
  const view = new ProviderRegistry(providers).getView();
  assert.equal(
    view.providers.find((item) => item.providerId === "p-explicit")?.displayMode,
    "other",
  );
  assert.equal(
    view.providers.find((item) => item.providerId === "p-legacy")?.displayMode,
    "expanded",
  );
  assert.equal(
    view.providers.find((item) => item.providerId === "p-default")?.displayMode,
    "submenu",
  );
  const projected = view.providers.map(projectModelSelectionProviderView);
  assert.deepEqual(
    projected.map((item) => [item.providerId, item.displayMode]),
    [
      ["p-explicit", "other"],
      ["p-legacy", "expanded"],
      ["p-default", "submenu"],
    ],
  );
});

test("个人覆盖层 JSON 往返保留 displayMode", () => {
  const stored = new ProviderConfigMap([
    {
      providerId: "p1",
      displayMode: "expanded",
      config: new ProviderConfig({ group: "standard-personal" }),
    },
  ]);
  // toJSON 写盘、parsePersonalProviderConfigMap 读盘：规则外层字段随 overlay 自动跟随。
  const reloaded = parsePersonalProviderConfigMap({ providerRules: stored.toJSON() });
  assert.equal(reloaded.getRule("p1")?.displayMode, "expanded");
});

test("保存 metadata 稀疏补丁写 displayMode 且不再写 isPrimary，未写沿用旧值", async () => {
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
    displayMode: "other",
  });

  let rule = (await repository.read()).providers.getRule("p1");
  assert.equal(rule?.displayMode, "other");
  // 新写入只产生 displayMode，不再产生 isPrimary。
  assert.equal(rule?.isPrimary, undefined);

  // 未写 displayMode 的补丁不覆盖旧值（与 enabled 同层的稀疏语义）。
  await service.savePersonalProviderOverlay("p1", new ProviderConfig(), undefined, {});
  rule = (await repository.read()).providers.getRule("p1");
  assert.equal(rule?.displayMode, "other");
  assert.equal(rule?.enabled, true);
});
