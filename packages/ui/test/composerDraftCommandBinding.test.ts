import assert from "node:assert/strict";
import test from "node:test";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "../src/v4/composer/composerDraftStore.js";

// 命令绑定着色（docs/specs/command-model-binding.md）的草稿持久化：
// commandBinding 快照随草稿落盘，重挂载后删芯片仍能回到进入前的选择；
// 坏绑定收敛为丢弃着色，不能连带丢正文选择。

class MemoryStorage {
  #store = new Map<string, string>();

  get length() {
    return this.#store.size;
  }

  getItem(key: string) {
    return this.#store.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.#store.set(key, value);
  }

  removeItem(key: string) {
    this.#store.delete(key);
  }

  clear() {
    this.#store.clear();
  }
}

function withMemoryStorage(run: () => void) {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const storage = new MemoryStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  try {
    run();
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
}

const WORKSPACE = "/tmp/ycode-command-binding";
const BINDING = { providerId: "zcode", modelId: "glm-5.3" };
const SNAPSHOT = { providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "high" } };

test("commandBinding 快照随草稿写入并可完整读回", () => {
  withMemoryStorage(() => {
    persistV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "/compact 整理一下",
      modelSelection: BINDING,
      commandBinding: { name: "compact", binding: BINDING, snapshot: SNAPSHOT },
    });
    const draft = readV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT);
    assert.deepEqual(draft?.commandBinding, {
      name: "compact",
      binding: BINDING,
      snapshot: SNAPSHOT,
    });
    assert.deepEqual(draft?.modelSelection, BINDING);
  });
});

test("snapshot 缺省（进入前无选择）也能读回 undefined 语义", () => {
  withMemoryStorage(() => {
    persistV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "/compact",
      modelSelection: BINDING,
      commandBinding: { name: "compact", binding: BINDING },
    });
    const draft = readV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT);
    assert.equal(draft?.commandBinding?.snapshot, undefined);
  });
});

test("坏绑定（缺 modelId）只丢着色，正文与草稿选择保留", () => {
  withMemoryStorage(() => {
    const key = `zcode-v4-composer-drafts:v1:${encodeURIComponent(WORKSPACE)}`;
    window.localStorage!.setItem(
      key,
      JSON.stringify({
        version: 1,
        scopes: {
          [V4_DRAFT_SCOPE_ROOT]: {
            text: "/compact",
            modelSelection: SNAPSHOT,
            commandBinding: { name: "compact", binding: { providerId: "openai" } },
            updatedAt: 1,
          },
        },
      }),
    );
    const draft = readV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT);
    assert.equal(draft?.commandBinding, undefined);
    assert.deepEqual(draft?.modelSelection, SNAPSHOT);
    assert.equal(draft?.text, "/compact");
  });
});

test("删除绑定后清空着色，草稿选择回到快照值", () => {
  withMemoryStorage(() => {
    persistV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "/compact",
      modelSelection: BINDING,
      commandBinding: { name: "compact", binding: BINDING, snapshot: SNAPSHOT },
    });
    persistV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "",
      modelSelection: SNAPSHOT,
    });
    const draft = readV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT);
    assert.equal(draft?.commandBinding, undefined);
    assert.deepEqual(draft?.modelSelection, SNAPSHOT);
    assert.equal(draft?.text, "");
  });
});

test("仅剩 commandBinding 的草稿不因清空正文而被整条删除", () => {
  withMemoryStorage(() => {
    persistV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "",
      commandBinding: { name: "compact", binding: BINDING },
    });
    const draft = readV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT);
    assert.equal(draft?.commandBinding?.name, "compact");
    clearV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT);
    assert.equal(readV4ComposerDraft(WORKSPACE, undefined, V4_DRAFT_SCOPE_ROOT), null);
  });
});
