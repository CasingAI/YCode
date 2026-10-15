import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "../src/index.js";

// 分组顺序（docs/specs/opencode-usage-quota.md「分组顺序（分组整体拖拽）」）：
// 显式持久化偏好，随 reorderPersonalProviders 原子写入；任何字段编辑都不得清掉该键。

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

function createService(snapshot: Omit<ProviderConfigLayerSnapshot, "revision">) {
  const repository = new MemoryPersonalRepository(snapshot);
  const service = new ProviderConfigService({
    zcodeBuiltinSource: new StaticSource({
      revision: "builtin-1",
      providers: ProviderConfigMap.empty(),
      models: ModelConfigRules.empty(),
    }),
    personalRepository: repository as never,
  });
  return { service, repository };
}

function personalSnapshot(
  providerOrder: string[],
  providerGroupOrder?: string[],
): Omit<ProviderConfigLayerSnapshot, "revision"> {
  return {
    providers: new ProviderConfigMap([
      {
        providerId: "p1",
        providerName: "P1",
        enabled: true,
        config: new ProviderConfig({ group: "standard-personal" }),
      },
    ]),
    models: ModelConfigRules.empty(),
    providerOrder,
    ...(providerGroupOrder === undefined ? {} : { providerGroupOrder }),
  };
}

test("reorderPersonalProviders 原子写入 providerOrder 与 providerGroupOrder", async () => {
  const { service, repository } = createService(personalSnapshot(["p1"]));
  await service.reorderPersonalProviders(["p1"], ["cliproxy", "opencode", "custom"]);
  const snapshot = await repository.read();
  assert.deepEqual(snapshot.providerOrder, ["p1"]);
  assert.deepEqual(snapshot.providerGroupOrder, ["cliproxy", "opencode", "custom"]);
});

test("不带组序的重排调用不清掉已保存的 providerGroupOrder", async () => {
  const { service, repository } = createService(personalSnapshot(["p1"], ["custom"]));
  await service.reorderPersonalProviders(["p1"]);
  assert.deepEqual((await repository.read()).providerGroupOrder, ["custom"]);
});

test("其他字段编辑（模型组 Primary）保留 providerGroupOrder", async () => {
  const { service, repository } = createService(personalSnapshot(["p1"], ["custom", "opencode"]));
  await service.setPersonalModelGroupsPrimary(true);
  const snapshot = await repository.read();
  assert.equal(snapshot.modelGroupsPrimary, true);
  assert.deepEqual(snapshot.providerGroupOrder, ["custom", "opencode"]);
});

test("read() 快照透传 personalProviderGroupOrder", async () => {
  const { service } = createService(personalSnapshot(["p1"], ["cliproxy"]));
  const config = await service.read();
  assert.deepEqual(config.personalProviderGroupOrder, ["cliproxy"]);
});

test("组序写入前做净化：去空白、去重", async () => {
  const { service, repository } = createService(personalSnapshot(["p1"]));
  await service.reorderPersonalProviders(["p1"], [" custom ", "cliproxy", "custom"]);
  assert.deepEqual((await repository.read()).providerGroupOrder, ["custom", "cliproxy"]);
});
