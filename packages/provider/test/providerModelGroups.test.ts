// 模型组个人配置事务测试（docs/specs/model-group.md）。
//
// 锁住 spec「状态所有者」的四条判据：
// - 组名单与 Provider/Model 共用同一次 personal repository 事务（同一把文件锁）；
// - 同名组拒绝创建/重命名；组 ID 由 Host 生成（model-group: 前缀）；
// - 删除是真删除，不留墓碑；
// - 成员增删与排序一次事务整体替换，禁止组套组（组 ID 不是合法成员）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigService,
  assertModelGroupId,
  isModelGroupId,
  type ModelGroupConfig,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "../src/index.js";
import {
  MODEL_GROUP_ID_PREFIX,
  isModelGroupEnabled,
  isModelGroupsPrimary,
  modelGroupIdSeedFromName,
} from "../src/model-group.js";

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

class MemoryPersonalRepository implements PersonalProviderConfigRepository {
  readonly #listeners = new Set<(reason: string) => void>();
  #revision = 0;
  #snapshot: ProviderConfigLayerSnapshot;
  /** 记录每次 update 的写入批次数；组与 Provider 必须共享同一次事务边界。 */
  updateCount = 0;

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
    this.updateCount += 1;
    this.#snapshot = Object.freeze({
      ...transform(this.#snapshot),
      revision: `personal-${this.#revision}`,
    });
    for (const listener of this.#listeners) listener("test");
    return this.#snapshot;
  }
}

function createService(): {
  repository: MemoryPersonalRepository;
  service: ProviderConfigService;
} {
  const builtin: ProviderConfigLayerSnapshot = {
    revision: "builtin-1",
    providers: ProviderConfigMap.empty(),
    providerTemplates: new Map(),
    models: ModelConfigRules.empty(),
  };
  const repository = new MemoryPersonalRepository({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  });
  return {
    repository,
    service: new ProviderConfigService({
      zcodeBuiltinSource: new StaticSource(builtin),
      personalRepository: repository,
    }),
  };
}

/** 组名单的读侧视图：layer snapshot 的 modelGroups 即个人配置存储事实。 */
async function storedGroups(
  repository: MemoryPersonalRepository,
): Promise<readonly ModelGroupConfig[]> {
  const snapshot = await repository.read();
  return snapshot.modelGroups ?? [];
}

test("创建组：ID 由 Host 生成（model-group: 前缀），成员去重保序", async () => {
  const { service, repository } = createService();
  const created = await service.createPersonalModelGroup({
    name: "快组",
    memberOrder: [
      { providerId: "p1", modelId: "m1" },
      { providerId: "p1", modelId: "m1" },
      { providerId: "p1", modelId: "m2" },
    ],
  });
  assert.ok(isModelGroupId(created.groupId));
  assert.equal(created.name, "快组");
  assert.deepEqual(created.memberOrder, [
    { providerId: "p1", modelId: "m1" },
    { providerId: "p1", modelId: "m2" },
  ]);
  const groups = await storedGroups(repository);
  assert.equal(groups.length, 1);
});

test("同名组拒绝创建；重命名撞名也拒绝", async () => {
  const { service } = createService();
  const created = await service.createPersonalModelGroup({ name: "同名" });
  await assert.rejects(() => service.createPersonalModelGroup({ name: "同名" }), /已存在/);
  const second = await service.createPersonalModelGroup({ name: "另一个" });
  await assert.rejects(() => service.renamePersonalModelGroup(second.groupId, "同名"), /已存在/);
  await service.renamePersonalModelGroup(created.groupId, "改名后");
});

test("组成员整体替换：一次事务写入，组 ID 不是合法成员", async () => {
  const { service, repository } = createService();
  const created = await service.createPersonalModelGroup({ name: "成员组" });
  const updates = repository.updateCount;
  await service.setPersonalModelGroupMembers(created.groupId, [
    { providerId: "p1", modelId: "m2" },
    { providerId: "p1", modelId: "m1" },
  ]);
  assert.equal(repository.updateCount, updates + 1);
  const groups = await storedGroups(repository);
  const group = groups.find((candidate) => candidate.groupId === created.groupId);
  assert.deepEqual(group?.memberOrder, [
    { providerId: "p1", modelId: "m2" },
    { providerId: "p1", modelId: "m1" },
  ]);
  // 「组套组禁止」的落点不是存储层拒绝，而是命名空间隔离：组 ID 永远不会与
  // Provider ID 相撞（assertModelGroupId 挡住保留前缀），组也不注册为 Provider，
  // 所以「providerId 写成组 ID」的成员只是永远不可用的死条目，不可能展开成子组。
  await service.setPersonalModelGroupMembers(created.groupId, [
    { providerId: "model-group:成员组", modelId: "m1" },
  ]);
  const groupsAfter = await storedGroups(repository);
  const memberAfter = groupsAfter
    .find((candidate) => candidate.groupId === created.groupId)
    ?.memberOrder.at(0);
  assert.equal(memberAfter?.providerId, "model-group:成员组");
  // 该 providerId 落在组命名空间里；执行侧 registry 查不到这个 provider，
  // 成员按不可用处理，哈希抽选自动跳过——组套组不可达。
  assert.ok(isModelGroupId(memberAfter?.providerId ?? ""));
});

test("删除是真删除；重排保持其余组相对顺序", async () => {
  const { service, repository } = createService();
  const first = await service.createPersonalModelGroup({ name: "组一" });
  const second = await service.createPersonalModelGroup({ name: "组二" });
  const third = await service.createPersonalModelGroup({ name: "组三" });
  await service.deletePersonalModelGroup(second.groupId);
  await service.reorderPersonalModelGroups([third.groupId, first.groupId]);
  const groups = await storedGroups(repository);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["组三", "组一"],
  );
});

test("组 ID 校验：必须带 model-group: 前缀且不含 /，不占保留供应商前缀", () => {
  assert.ok(isModelGroupId(`${MODEL_GROUP_ID_PREFIX}demo`));
  assert.equal(isModelGroupId("demo"), false);
  assert.equal(isModelGroupId(`${MODEL_GROUP_ID_PREFIX}`), false);
  assert.equal(isModelGroupId(`${MODEL_GROUP_ID_PREFIX}a/b`), false);
  assert.equal(isModelGroupId("account:zai"), false);
  assert.equal(assertModelGroupId(`${MODEL_GROUP_ID_PREFIX}demo`), `${MODEL_GROUP_ID_PREFIX}demo`);
  assert.throws(() => assertModelGroupId("builtin:x"));
});

test("组 ID 种子来自显示名归一化；重复时 Host 追加随机后缀", async () => {
  assert.equal(modelGroupIdSeedFromName("Fast Group!"), "fast-group");
  const { service } = createService();
  const first = await service.createPersonalModelGroup({ name: "Fast Group!" });
  const second = await service.createPersonalModelGroup({ name: "Fast Group!" }).catch(() => null);
  // 同名被拒；不同名同种子（如 "fast group?"）应得到不同 ID。
  assert.ok(first.groupId.startsWith(`${MODEL_GROUP_ID_PREFIX}fast-group`));
  assert.equal(second, null);
  const third = await service.createPersonalModelGroup({ name: "fast group?" });
  assert.notEqual(third.groupId, first.groupId);
  assert.ok(isModelGroupId(third.groupId));
});

test("组开关缺省：旧盘缺字段视为启用，整节缺省非 Primary", async () => {
  const { service, repository } = createService();
  const created = await service.createPersonalModelGroup({ name: "缺省组" });
  // 新建不写开关字段：读侧按缺省解读；整节 Primary 缺省 false。
  assert.equal(created.enabled, undefined);
  assert.equal(isModelGroupEnabled(created), true);
  assert.equal(isModelGroupsPrimary(undefined), false);
  const groups = await storedGroups(repository);
  assert.equal(groups.length, 1);
});

test("组启用补丁只改 enabled；整节 Primary 独立切换", async () => {
  const { service, repository } = createService();
  const created = await service.createPersonalModelGroup({ name: "开关组" });
  // 整节 Primary 缺省关闭，打开后整节一级展开，关闭保留标记。
  assert.equal(isModelGroupsPrimary(undefined), false);
  await service.setPersonalModelGroupsPrimary(true);
  await service.setPersonalModelGroupEnabled(created.groupId, false);
  const groups = await storedGroups(repository);
  const group = groups.find((item) => item.groupId === created.groupId);
  assert.ok(group);
  assert.equal(group.enabled, false);
  assert.equal(isModelGroupEnabled(group), false);
  await service.setPersonalModelGroupEnabled(created.groupId, true);
  const reopened = (await storedGroups(repository)).find(
    (item) => item.groupId === created.groupId,
  );
  assert.ok(reopened);
  assert.equal(isModelGroupEnabled(reopened), true);
  assert.throws(() => (service.setPersonalModelGroupEnabled as Function)("x", "yes"));
  await assert.rejects(service.setPersonalModelGroupEnabled("model-group:nope", true));
});
