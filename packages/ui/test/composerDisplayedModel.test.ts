import assert from "node:assert/strict";
import test from "node:test";
import {
  readComposerDisplayedModel,
  recordComposerDisplayedModel,
  resolveComposerDisplayedModelIntent,
  resolveComposerDisplayedModelSelection,
  resolveForegroundDisplayedModel,
} from "../src/lib/composerDisplayedModel.js";
import { captureComposerRecentSubmission, readComposerRecent } from "../src/lib/composerRecent.js";
import { resolveAiSearchModelInput } from "../src/command-center/aiSearchModelInput.js";

// 工作区“最后展示的模型意图”记录（docs/specs/composer-displayed-model.md）：
// 前台 Composer 真正展示具体可用模型或模型组时写入，命令中心读取时优先于最近提交偏好。

class MemoryStorage {
  readonly data = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.data.set(key, value);
  }
}

const catalog = {
  providers: [
    {
      providerId: "p1",
      config: { api: { type: "openai-chat-completions" } },
      models: [
        {
          modelId: "m-multi",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
        {
          modelId: "m-plain",
          config: { optionSpecs: { reasoningLevel: { values: [] } } },
        },
      ],
    },
    {
      providerId: "p-unsupported",
      config: { api: null },
      models: [{ modelId: "m1", config: { optionSpecs: { reasoningLevel: { values: [] } } } }],
    },
  ],
};

const groupView = {
  providers: catalog.providers,
  modelGroups: [{ groupId: "g1", name: "新组名", members: [], enabled: true }],
};

const STORAGE_KEY = "zcode-composer-displayed-model-v1:C:/ws";

test("旧 v1 具体选择记录仍可读，identity 去空白优先于路径", () => {
  const storage = new MemoryStorage();
  const selection = { providerId: "p1", modelId: "m-multi", options: { reasoningLevel: "high" } };
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, selection }));

  assert.deepEqual(readComposerDisplayedModel("C:/ws", undefined, storage), { selection });
  assert.equal(readComposerDisplayedModel("C:/other", undefined, storage), null);

  recordComposerDisplayedModel("C:/ws", { selection }, "  identity-1  ", storage);
  assert.deepEqual(readComposerDisplayedModel("C:/ws", "identity-1", storage), { selection });
  assert.ok([...storage.data.keys()][1]!.endsWith(":identity-1"));
});

test("identity 为空时退回 workspacePath", () => {
  const storage = new MemoryStorage();
  recordComposerDisplayedModel(
    "C:/ws",
    { selection: { providerId: "p1", modelId: "m-plain" } },
    "   ",
    storage,
  );
  assert.ok([...storage.data.keys()][0]!.endsWith(":C:/ws"));
  assert.deepEqual(readComposerDisplayedModel("C:/ws", undefined, storage), {
    selection: { providerId: "p1", modelId: "m-plain" },
  });
});

test("相同具体选择不重复写 localStorage", () => {
  const storage = new MemoryStorage();
  const selection = { providerId: "p1", modelId: "m-multi" };
  recordComposerDisplayedModel("C:/ws", { selection }, undefined, storage);
  recordComposerDisplayedModel("C:/ws", { selection: { ...selection } }, undefined, storage);
  assert.equal(storage.writes, 1);

  recordComposerDisplayedModel(
    "C:/ws",
    { selection: { ...selection, options: { reasoningLevel: "low" } } },
    undefined,
    storage,
  );
  assert.equal(storage.writes, 2);
});

test("坏存储、坏 JSON、版本不匹配、schema 不合法都读成 null", () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, "{");
  assert.equal(readComposerDisplayedModel("C:/ws", undefined, storage), null);

  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 2, selection: { providerId: "p1", modelId: "m1" } }),
  );
  assert.equal(readComposerDisplayedModel("C:/ws", undefined, storage), null);

  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 1, selection: { providerId: "", modelId: "m1" } }),
  );
  assert.equal(readComposerDisplayedModel("C:/ws", undefined, storage), null);

  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 1, modelGroupIntent: { groupId: "  ", groupNameSnapshot: "组" } }),
  );
  assert.equal(readComposerDisplayedModel("C:/ws", undefined, storage), null);
});

test("坏混合记录同时含合法具体与组：按既有 recent 规则优先具体", () => {
  const storage = new MemoryStorage();
  const selection = { providerId: "p1", modelId: "m-multi" };
  const modelGroupIntent = { groupId: "g1", groupNameSnapshot: "组" };
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, selection, modelGroupIntent }));
  assert.deepEqual(readComposerDisplayedModel("C:/ws", undefined, storage), { selection });
});

test("存储不可用时不抛错", () => {
  const throwing = {
    getItem(): string | null {
      throw new Error("blocked");
    },
    setItem(): void {
      throw new Error("blocked");
    },
  };
  assert.equal(readComposerDisplayedModel("C:/ws", undefined, throwing), null);
  assert.doesNotThrow(() =>
    recordComposerDisplayedModel(
      "C:/ws",
      { selection: { providerId: "p1", modelId: "m1" } },
      undefined,
      throwing,
    ),
  );
  assert.doesNotThrow(() =>
    recordComposerDisplayedModel(
      "C:/ws",
      { modelGroupIntent: { groupId: "g1", groupNameSnapshot: "组" } },
      undefined,
      throwing,
    ),
  );
});

test("组意图 roundtrip、identity key 与同值去重", () => {
  const storage = new MemoryStorage();
  const modelGroupIntent = { groupId: "g1", groupNameSnapshot: "省钱组" };
  recordComposerDisplayedModel("C:/ws", { modelGroupIntent }, "id-1", storage);

  assert.deepEqual(readComposerDisplayedModel("C:/ws", "id-1", storage), { modelGroupIntent });
  assert.ok([...storage.data.keys()][0]!.endsWith(":id-1"));
  assert.equal(storage.writes, 1);

  // 名快照同值的不同对象不重复写。
  recordComposerDisplayedModel(
    "C:/ws",
    { modelGroupIntent: { groupId: "g1", groupNameSnapshot: "省钱组" } },
    "id-1",
    storage,
  );
  assert.equal(storage.writes, 1);
});

test("组与具体互相整体覆盖，单条记录只留一侧", () => {
  const storage = new MemoryStorage();
  const selection = { providerId: "p1", modelId: "m-multi" };
  const modelGroupIntent = { groupId: "g1", groupNameSnapshot: "省钱组" };

  recordComposerDisplayedModel("C:/ws", { selection }, undefined, storage);
  recordComposerDisplayedModel("C:/ws", { modelGroupIntent }, undefined, storage);
  assert.equal(storage.data.size, 1);
  assert.deepEqual(readComposerDisplayedModel("C:/ws", undefined, storage), { modelGroupIntent });
  const afterGroup = JSON.parse(storage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
  assert.equal("selection" in afterGroup, false);

  recordComposerDisplayedModel("C:/ws", { selection }, undefined, storage);
  assert.deepEqual(readComposerDisplayedModel("C:/ws", undefined, storage), { selection });
  const afterSelection = JSON.parse(storage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
  assert.equal("modelGroupIntent" in afterSelection, false);
  assert.equal(storage.writes, 3);
});

test("异常双值输入只写具体一侧，不产生双字段记录", () => {
  const storage = new MemoryStorage();
  const selection = { providerId: "p1", modelId: "m-multi" };
  const modelGroupIntent = { groupId: "g1", groupNameSnapshot: "组" };
  recordComposerDisplayedModel(
    "C:/ws",
    { selection, modelGroupIntent } as never,
    undefined,
    storage,
  );
  assert.deepEqual(readComposerDisplayedModel("C:/ws", undefined, storage), { selection });
  assert.equal("modelGroupIntent" in JSON.parse(storage.getItem(STORAGE_KEY)!), false);
});

test("展示判据：只接受目录里可选的具体模型", () => {
  assert.deepEqual(
    resolveComposerDisplayedModelSelection({
      displayProvider: "glm",
      view: catalog,
      selection: { providerId: "p1", modelId: "m-multi", options: { reasoningLevel: "high" } },
    }),
    { providerId: "p1", modelId: "m-multi", options: { reasoningLevel: "high" } },
  );

  // 档位表不接受的档位不写入记录（Composer 实际展示为空档）。
  assert.deepEqual(
    resolveComposerDisplayedModelSelection({
      displayProvider: "glm",
      view: catalog,
      selection: { providerId: "p1", modelId: "m-multi", options: { reasoningLevel: "bogus" } },
    }),
    { providerId: "p1", modelId: "m-multi" },
  );
});

test("展示判据：视图未就绪、provider/model 缺失、无 api 格式、synthetic 都返回 null", () => {
  const base = { displayProvider: "glm" as const };
  assert.equal(
    resolveComposerDisplayedModelSelection({
      ...base,
      view: null,
      selection: { providerId: "p1", modelId: "m-multi" },
    }),
    null,
  );
  assert.equal(
    resolveComposerDisplayedModelSelection({
      ...base,
      view: catalog,
      selection: { providerId: "p-gone", modelId: "m-multi" },
    }),
    null,
  );
  assert.equal(
    resolveComposerDisplayedModelSelection({
      ...base,
      view: catalog,
      selection: { providerId: "p1", modelId: "m-gone" },
    }),
    null,
  );
  assert.equal(
    resolveComposerDisplayedModelSelection({
      ...base,
      view: catalog,
      selection: { providerId: "p-unsupported", modelId: "m1" },
    }),
    null,
  );
  assert.equal(
    resolveComposerDisplayedModelSelection({
      ...base,
      view: catalog,
      selection: { providerId: "p1", modelId: "<synthetic>" },
    }),
    null,
  );
  assert.equal(
    resolveComposerDisplayedModelSelection({ ...base, view: catalog, selection: null }),
    null,
  );
});

test("组判据：空组/已删/停用/目录未就绪都记录组 id + 名快照，不编成员", () => {
  const groupIntent = { groupId: "g-gone", groupNameSnapshot: "旧组名" };
  for (const view of [
    null,
    { providers: catalog.providers },
    { providers: catalog.providers, modelGroups: [] },
    // 停用组由 Facade 预过滤：视图里没有该组时同样只能回名快照。
    {
      providers: catalog.providers,
      modelGroups: [{ groupId: "g-other", name: "其他组", members: [], enabled: true }],
    },
  ]) {
    assert.deepEqual(
      resolveComposerDisplayedModelIntent({
        displayProvider: "glm",
        view,
        selection: null,
        groupIntent,
      }),
      { modelGroupIntent: groupIntent },
    );
  }
});

test("组名回填：当前视图名优先于名快照，组删后保留快照", () => {
  const groupIntent = { groupId: "g1", groupNameSnapshot: "旧组名" };
  assert.deepEqual(
    resolveComposerDisplayedModelIntent({
      displayProvider: "glm",
      view: groupView,
      selection: null,
      groupIntent,
    }),
    { modelGroupIntent: { groupId: "g1", groupNameSnapshot: "新组名" } },
  );
  assert.deepEqual(
    resolveComposerDisplayedModelIntent({
      displayProvider: "glm",
      view: { providers: catalog.providers },
      selection: null,
      groupIntent,
    }),
    { modelGroupIntent: groupIntent },
  );
});

test("具体可用模型优先于组意图；具体不可用时组仍记录", () => {
  const groupIntent = { groupId: "g1", groupNameSnapshot: "旧组名" };
  assert.deepEqual(
    resolveComposerDisplayedModelIntent({
      displayProvider: "glm",
      view: groupView,
      selection: { providerId: "p1", modelId: "m-multi" },
      groupIntent,
    }),
    { selection: { providerId: "p1", modelId: "m-multi" } },
  );
  assert.deepEqual(
    resolveComposerDisplayedModelIntent({
      displayProvider: "glm",
      view: groupView,
      selection: { providerId: "p1", modelId: "m-gone" },
      groupIntent,
    }),
    { modelGroupIntent: { groupId: "g1", groupNameSnapshot: "新组名" } },
  );
});

test("前台判据：后台 pane / 隐藏 tab / 辅助只读 Composer 都不产生记录（具体与组）", () => {
  const base = {
    displayProvider: "glm" as const,
    view: groupView,
  };
  const foreground = {
    focused: true,
    visible: true,
    readOnly: false,
    selectionSideChat: false,
  };
  const concrete = { selection: { providerId: "p1", modelId: "m-multi" }, groupIntent: null };
  const group = {
    selection: null,
    groupIntent: { groupId: "g1", groupNameSnapshot: "旧组名" },
  };
  assert.deepEqual(resolveForegroundDisplayedModel({ foreground, ...base, ...concrete }), {
    selection: { providerId: "p1", modelId: "m-multi" },
  });
  assert.deepEqual(resolveForegroundDisplayedModel({ foreground, ...base, ...group }), {
    modelGroupIntent: { groupId: "g1", groupNameSnapshot: "新组名" },
  });
  for (const blocked of [
    { ...foreground, focused: false },
    { ...foreground, visible: false },
    { ...foreground, readOnly: true },
    { ...foreground, selectionSideChat: true },
  ]) {
    assert.equal(
      resolveForegroundDisplayedModel({ foreground: blocked, ...base, ...concrete }),
      null,
    );
    assert.equal(resolveForegroundDisplayedModel({ foreground: blocked, ...base, ...group }), null);
  }
});

// 组合链路（docs/specs/composer-displayed-model.md）：命令中心读取 → getView → 最低档。
// 这里用一个最小的视图替身代替工作区模型服务（node 测试不构造 Service），使真实链路
// 「displayed 记录 → aiSearchModelInput → 视图 effectiveSelection → 搜索档位」可执行。
type SearchSelection = {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
};

const searchCatalog = {
  providers: [
    {
      providerId: "p1",
      config: { api: { type: "openai-chat-completions" } },
      models: [
        {
          modelId: "m-recent",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
        {
          modelId: "m-displayed",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
        {
          modelId: "m-preferred",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
      ],
    },
  ],
};

/** 视图替身：input 命中目录时作为 effectiveSelection，否则回 preferredSelection。 */
function fakeGetView(input: { selection: SearchSelection } | undefined) {
  const selection = input?.selection;
  const found = selection
    ? searchCatalog.providers
        .find((provider) => provider.providerId === selection.providerId)
        ?.models.find((model) => model.modelId === selection.modelId)
    : undefined;
  return {
    ...searchCatalog,
    effectiveSelection: found ? selection : null,
    preferredSelection: { providerId: "p1", modelId: "m-preferred" },
  };
}

test("组合链路：已发送 A、前台展示具体 B 未发送 → 命令中心读 B、视图解析 B、搜索最低档仍是 B", () => {
  const storage = new MemoryStorage();
  const workspacePath = "C:/ws";
  const sentA = { providerId: "p1", modelId: "m-recent", options: { reasoningLevel: "high" } };
  const shownB = { providerId: "p1", modelId: "m-displayed", options: { reasoningLevel: "high" } };

  // 近期偏好只有 accepted 发送会写；B 仅在前台 Composer 展示，没有被发送。
  captureComposerRecentSubmission(
    workspacePath,
    { modelSelection: sentA, mode: "yolo" },
    undefined,
    storage,
  )();
  recordComposerDisplayedModel(workspacePath, { selection: shownB }, undefined, storage);

  const displayed = readComposerDisplayedModel(workspacePath, undefined, storage);
  const recent = readComposerRecent(workspacePath, undefined, storage);
  assert.deepEqual(displayed, { selection: shownB });
  assert.deepEqual(recent?.modelSelection, sentA);

  const input = resolveAiSearchModelInput(displayed, recent);
  assert.deepEqual(input, { selection: shownB });

  const view = fakeGetView(input as { selection: SearchSelection });
  assert.deepEqual(view.effectiveSelection, shownB);
  // 最低档规则由 aiSearchModelLevel.test.ts 单独覆盖；这里只确认视图解析到展示的 B。

  // displayed 记录与 recent 偏好互不写回：命令中心读取不会改动任一存储。
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    selection: shownB,
  });
  assert.deepEqual(readComposerRecent(workspacePath, undefined, storage)?.modelSelection, sentA);
});

test("组合链路：前台展示组 G、recent 是具体 A → 输入只带组 G，不编具体", () => {
  const storage = new MemoryStorage();
  const workspacePath = "C:/ws";
  const sentA = { providerId: "p1", modelId: "m-recent", options: { reasoningLevel: "high" } };
  const groupG = { groupId: "g1", groupNameSnapshot: "省钱组" };

  captureComposerRecentSubmission(
    workspacePath,
    { modelSelection: sentA, mode: "yolo" },
    undefined,
    storage,
  )();
  recordComposerDisplayedModel(workspacePath, { modelGroupIntent: groupG }, undefined, storage);

  const input = resolveAiSearchModelInput(
    readComposerDisplayedModel(workspacePath, undefined, storage),
    readComposerRecent(workspacePath, undefined, storage),
  );
  assert.deepEqual(input, { modelGroupIntent: groupG });
  assert.ok(input);
  assert.equal("selection" in input, false);
});

test("组合链路：displayed 缺失时退回 recent 具体/组，搜索仍按具体身份解析", () => {
  const storage = new MemoryStorage();
  const workspacePath = "C:/ws";
  const sentA = { providerId: "p1", modelId: "m-recent", options: { reasoningLevel: "high" } };
  captureComposerRecentSubmission(
    workspacePath,
    { modelSelection: sentA, mode: "yolo" },
    undefined,
    storage,
  )();

  const input = resolveAiSearchModelInput(
    readComposerDisplayedModel(workspacePath, undefined, storage),
    readComposerRecent(workspacePath, undefined, storage),
  );
  assert.deepEqual(input, { selection: sentA });
  const view = fakeGetView(input as { selection: SearchSelection });
  assert.deepEqual(view.effectiveSelection, sentA);

  // recent 是组意图时同样回退为组，不展开成员。
  const groupStorage = new MemoryStorage();
  const groupG = { groupId: "g2", groupNameSnapshot: "备选组" };
  captureComposerRecentSubmission(
    workspacePath,
    { modelGroupIntent: groupG, mode: "yolo" },
    undefined,
    groupStorage,
  )();
  assert.deepEqual(
    resolveAiSearchModelInput(null, readComposerRecent(workspacePath, undefined, groupStorage)),
    { modelGroupIntent: groupG },
  );
});

// 前台 pane 的焦点/可见性门与 SessionPane effect 使用同一判据；这里按帧模拟 effect，
// 确认后台 pane 的模型/目录变化不会抢写，焦点回到原 pane 时记录会重新对齐。
type Foreground = {
  focused: boolean;
  visible: boolean;
  readOnly: boolean;
  selectionSideChat: boolean;
};
const FOCUSED: Foreground = {
  focused: true,
  visible: true,
  readOnly: false,
  selectionSideChat: false,
};
const BACKGROUND: Foreground = { ...FOCUSED, focused: false };

const paneCatalog = {
  providers: [
    {
      providerId: "p1",
      config: { api: { type: "openai-chat-completions" } },
      models: [
        {
          modelId: "m-a",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
        {
          modelId: "m-b",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
        { modelId: "m-x", config: { optionSpecs: { reasoningLevel: { values: [] } } } },
      ],
    },
  ],
};

function applyPaneFrame(params: {
  storage: MemoryStorage;
  workspacePath: string;
  foreground: Foreground;
  selection?: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
}): void {
  const resolved = resolveForegroundDisplayedModel({
    foreground: params.foreground,
    displayProvider: "glm",
    view: paneCatalog,
    selection: params.selection ?? null,
    groupIntent: null,
  });
  if (!resolved) return;
  recordComposerDisplayedModel(params.workspacePath, resolved, undefined, params.storage);
}

test("焦点切换：前台 A → 切到 B 未修改未发送 → 焦点回 A 重新更新；后台更新不覆盖", () => {
  const storage = new MemoryStorage();
  const workspacePath = "C:/ws";
  const modelA = { providerId: "p1", modelId: "m-a", options: { reasoningLevel: "high" } };
  const modelB = { providerId: "p1", modelId: "m-b" };
  const modelX = { providerId: "p1", modelId: "m-x" };

  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    selection: modelA,
  });
  assert.equal(storage.writes, 1);

  // 焦点移到 B，但 B 仍是旧选择/未修改也未发送：本次不写。
  applyPaneFrame({ storage, workspacePath, foreground: BACKGROUND, selection: modelB });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    selection: modelA,
  });
  assert.equal(storage.writes, 1);

  // 后台 pane 的目录 / 会话变化同样不抢写。
  applyPaneFrame({ storage, workspacePath, foreground: BACKGROUND, selection: modelX });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    selection: modelA,
  });
  assert.equal(storage.writes, 1);

  // 焦点回到 A：effect 重新求值；值未变，按序列化去重不重复写。
  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    selection: modelA,
  });
  assert.equal(storage.writes, 1);

  // B 真正成为前台并展示 B 后才更新。
  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelB });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    selection: modelB,
  });

  // 焦点再回 A：记录重新对齐到 A（即使中途切过不同模型）。
  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    selection: modelA,
  });
  assert.equal(storage.writes, 3);
});

test("不同 scope 同一模型 A：焦点切换仍逐帧求值，值相同只写一次", () => {
  const storage = new MemoryStorage();
  const workspacePath = "C:/ws";
  const modelA = { providerId: "p1", modelId: "m-a" };

  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });
  applyPaneFrame({ storage, workspacePath, foreground: BACKGROUND, selection: modelA });
  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });

  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    selection: modelA,
  });
  assert.equal(storage.writes, 1);
});

function applyGroupFrame(params: {
  storage: MemoryStorage;
  workspacePath: string;
  foreground: Foreground;
  groupIntent: { groupId: string; groupNameSnapshot: string };
  view: typeof groupView | { providers: typeof catalog.providers };
}): void {
  const resolved = resolveForegroundDisplayedModel({
    foreground: params.foreground,
    displayProvider: "glm",
    view: params.view,
    selection: null,
    groupIntent: params.groupIntent,
  });
  if (!resolved) return;
  recordComposerDisplayedModel(params.workspacePath, resolved, undefined, params.storage);
}

test("组前台帧：组选择覆盖旧具体；后台改名/目录刷新不抢写，前台改名才更新", () => {
  const storage = new MemoryStorage();
  const workspacePath = "C:/ws";
  const oldSelection = { providerId: "p1", modelId: "m-a" };
  const groupIntent = { groupId: "g1", groupNameSnapshot: "旧组名" };

  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: oldSelection });
  assert.equal(storage.writes, 1);

  // 前台选组：即使目录未就绪也记录组 id + 名快照，覆盖旧具体。
  applyGroupFrame({
    storage,
    workspacePath,
    foreground: FOCUSED,
    groupIntent,
    view: { providers: catalog.providers },
  });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    modelGroupIntent: groupIntent,
  });
  assert.equal(storage.writes, 2);

  // 后台 pane 的目录刷新（改名可见）不抢写。
  applyGroupFrame({
    storage,
    workspacePath,
    foreground: BACKGROUND,
    groupIntent,
    view: groupView,
  });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    modelGroupIntent: groupIntent,
  });
  assert.equal(storage.writes, 2);

  // 前台目录刷新：当前视图名优先，前台改名才更新记录。
  applyGroupFrame({
    storage,
    workspacePath,
    foreground: FOCUSED,
    groupIntent,
    view: groupView,
  });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    modelGroupIntent: { groupId: "g1", groupNameSnapshot: "新组名" },
  });
  assert.equal(storage.writes, 3);

  // 后台具体模型更新也不能把组记录抢回具体。
  applyPaneFrame({
    storage,
    workspacePath,
    foreground: BACKGROUND,
    selection: oldSelection,
  });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), {
    modelGroupIntent: { groupId: "g1", groupNameSnapshot: "新组名" },
  });
  assert.equal(storage.writes, 3);
});
