import assert from "node:assert/strict";
import test from "node:test";
import {
  readComposerDisplayedModel,
  recordComposerDisplayedModel,
  resolveComposerDisplayedModelSelection,
  resolveForegroundDisplayedModelSelection,
} from "../src/lib/composerDisplayedModel.js";
import { captureComposerRecentSubmission, readComposerRecent } from "../src/lib/composerRecent.js";
import { resolveAiSearchModelInput } from "../src/command-center/aiSearchModelInput.js";
import { resolveAiSearchModelSelection } from "../src/command-center/aiSearchModelLevel.js";

// 工作区“最后展示的模型”记录（docs/specs/composer-displayed-model.md）：
// 前台 Composer 真正展示具体可用模型时写入，命令中心读取时优先于最近提交偏好。

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

test("写入后按 workspace 读回，identity 去空白优先于路径", () => {
  const storage = new MemoryStorage();
  const selection = { providerId: "p1", modelId: "m-multi", options: { reasoningLevel: "high" } };
  recordComposerDisplayedModel("C:/ws", selection, "  identity-1  ", storage);

  assert.deepEqual(readComposerDisplayedModel("C:/ws", "identity-1", storage), selection);
  const keys = [...storage.data.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0]!.endsWith(":identity-1"));
  // 同 workspace 的其它路径不会命中 identity 记录。
  assert.equal(readComposerDisplayedModel("C:/other", undefined, storage), null);
});

test("identity 为空时退回 workspacePath", () => {
  const storage = new MemoryStorage();
  recordComposerDisplayedModel("C:/ws", { providerId: "p1", modelId: "m-plain" }, "   ", storage);
  assert.ok([...storage.data.keys()][0]!.endsWith(":C:/ws"));
  assert.deepEqual(readComposerDisplayedModel("C:/ws", undefined, storage), {
    providerId: "p1",
    modelId: "m-plain",
  });
});

test("相同选择不重复写 localStorage", () => {
  const storage = new MemoryStorage();
  const selection = { providerId: "p1", modelId: "m-multi" };
  recordComposerDisplayedModel("C:/ws", selection, undefined, storage);
  recordComposerDisplayedModel("C:/ws", { ...selection }, undefined, storage);
  assert.equal(storage.writes, 1);

  recordComposerDisplayedModel(
    "C:/ws",
    { ...selection, options: { reasoningLevel: "low" } },
    undefined,
    storage,
  );
  assert.equal(storage.writes, 2);
});

test("坏存储、坏 JSON、版本不匹配、schema 不合法都读成 null", () => {
  const storage = new MemoryStorage();
  storage.setItem("zcode-composer-displayed-model-v1:C:/ws", "{");
  assert.equal(readComposerDisplayedModel("C:/ws", undefined, storage), null);

  storage.setItem(
    "zcode-composer-displayed-model-v1:C:/ws",
    JSON.stringify({ version: 2, selection: { providerId: "p1", modelId: "m1" } }),
  );
  assert.equal(readComposerDisplayedModel("C:/ws", undefined, storage), null);

  storage.setItem(
    "zcode-composer-displayed-model-v1:C:/ws",
    JSON.stringify({ version: 1, selection: { providerId: "", modelId: "m1" } }),
  );
  assert.equal(readComposerDisplayedModel("C:/ws", undefined, storage), null);
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
    recordComposerDisplayedModel("C:/ws", { providerId: "p1", modelId: "m1" }, undefined, throwing),
  );
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

test("前台判据：后台 pane / 隐藏 tab / 辅助只读 Composer 都不产生记录", () => {
  const base = {
    displayProvider: "glm" as const,
    view: catalog,
    selection: { providerId: "p1", modelId: "m-multi" },
  };
  const foreground = {
    focused: true,
    visible: true,
    readOnly: false,
    selectionSideChat: false,
  };
  assert.deepEqual(resolveForegroundDisplayedModelSelection({ foreground, ...base }), {
    providerId: "p1",
    modelId: "m-multi",
  });
  for (const blocked of [
    { ...foreground, focused: false },
    { ...foreground, visible: false },
    { ...foreground, readOnly: true },
    { ...foreground, selectionSideChat: true },
  ]) {
    assert.equal(resolveForegroundDisplayedModelSelection({ foreground: blocked, ...base }), null);
  }
});

// 组合链路（docs/specs/composer-displayed-model.md）：命令中心读取 → getView → 最低档。
// 这里用一个最小的视图替身代替工作区模型服务（node 测试不构造 Service），使真实链路
// 「displayed 记录 → aiSearchModelInput → 视图 effectiveSelection → 搜索档位」可执行。
type SearchSelection = { providerId: string; modelId: string };

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

test("组合链路：已发送 A、前台展示 B 未发送 → 命令中心读 B、视图解析 B、搜索最低档仍是 B", () => {
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
  recordComposerDisplayedModel(workspacePath, shownB, undefined, storage);

  const displayed = readComposerDisplayedModel(workspacePath, undefined, storage);
  const recent = readComposerRecent(workspacePath, undefined, storage)?.modelSelection;
  assert.deepEqual(displayed, shownB);
  assert.deepEqual(recent, sentA);

  const input = resolveAiSearchModelInput(displayed, recent);
  assert.deepEqual(input, { selection: shownB });

  const view = fakeGetView(input);
  assert.deepEqual(view.effectiveSelection, shownB);
  assert.deepEqual(resolveAiSearchModelSelection(view, view.effectiveSelection), {
    providerId: "p1",
    modelId: "m-displayed",
    options: { reasoningLevel: "low" },
  });

  // displayed 记录与 recent 偏好互不写回：命令中心读取不会改动任一存储。
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), shownB);
  assert.deepEqual(readComposerRecent(workspacePath, undefined, storage)?.modelSelection, sentA);
});

test("组合链路：displayed 缺失时命令中心退回 recent A，搜索仍是 A 的最低档", () => {
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
    readComposerRecent(workspacePath, undefined, storage)?.modelSelection,
  );
  assert.deepEqual(input, { selection: sentA });
  const view = fakeGetView(input);
  assert.deepEqual(resolveAiSearchModelSelection(view, view.effectiveSelection), {
    providerId: "p1",
    modelId: "m-recent",
    options: { reasoningLevel: "low" },
  });
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
  selection: { providerId: string; modelId: string; options?: { reasoningLevel?: string } } | null;
}): void {
  const resolved = resolveForegroundDisplayedModelSelection({
    foreground: params.foreground,
    displayProvider: "glm",
    view: paneCatalog,
    selection: params.selection,
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
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), modelA);
  assert.equal(storage.writes, 1);

  // 焦点移到 B，但 B 仍是旧选择/未修改也未发送：本次不写。
  applyPaneFrame({ storage, workspacePath, foreground: BACKGROUND, selection: modelB });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), modelA);
  assert.equal(storage.writes, 1);

  // 后台 pane 的目录 / 会话变化同样不抢写。
  applyPaneFrame({ storage, workspacePath, foreground: BACKGROUND, selection: modelX });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), modelA);
  assert.equal(storage.writes, 1);

  // 焦点回到 A：effect 重新求值；值未变，按序列化去重不重复写。
  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), modelA);
  assert.equal(storage.writes, 1);

  // B 真正成为前台并展示 B 后才更新。
  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelB });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), modelB);

  // 焦点再回 A：记录重新对齐到 A（即使中途切过不同模型）。
  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });
  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), modelA);
  assert.equal(storage.writes, 3);
});

test("不同 scope 同一模型 A：焦点切换仍逐帧求值，值相同只写一次", () => {
  const storage = new MemoryStorage();
  const workspacePath = "C:/ws";
  const modelA = { providerId: "p1", modelId: "m-a" };

  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });
  applyPaneFrame({ storage, workspacePath, foreground: BACKGROUND, selection: modelA });
  applyPaneFrame({ storage, workspacePath, foreground: FOCUSED, selection: modelA });

  assert.deepEqual(readComposerDisplayedModel(workspacePath, undefined, storage), modelA);
  assert.equal(storage.writes, 1);
});
