import assert from "node:assert/strict";
import test from "node:test";
import type * as Monaco from "monaco-editor";
import {
  disposeFilesMonacoModel,
  getOrCreateFilesMonacoModel,
  isWritingFilesMonacoModel,
  writeFilesMonacoModelValue,
} from "../src/files-workbench/filesMonacoModels.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

test("程序化灌入期间挡住模型回调，避免规范化差异来回写缓冲", () => {
  let version = 0;
  let heardUserChange = 0;
  const model = {
    getValue: () => `v${version}`,
    setValue: () => {
      version += 1;
      if (!isWritingFilesMonacoModel()) {
        heardUserChange += 1;
      }
    },
  };

  assert.equal(model.getValue(), "v0");
  writeFilesMonacoModelValue(model, "wanted");
  assert.equal(heardUserChange, 0);
  assert.equal(isWritingFilesMonacoModel(), false);
  assert.equal(model.getValue(), "v1");
});

test("模型值已与缓冲相同时不写盘、不抬 writing 计数", () => {
  const model = {
    getValue: () => "same",
    setValue: () => {
      throw new Error("相同正文不应再 setValue");
    },
  };
  writeFilesMonacoModelValue(model, "same");
  assert.equal(isWritingFilesMonacoModel(), false);
});

test("same canonical URI is reused across legacy buffer IDs instead of throwing", () => {
  const registry = new Map<string, FakeMonacoModel>();
  class FakeMonacoModel {
    private disposed = false;
    private language: string;
    constructor(
      private value: string,
      language: string,
      readonly uri: { toString: () => string },
    ) {
      this.language = language;
    }
    getValue() {
      return this.value;
    }
    setValue(value: string) {
      this.value = value;
    }
    getLanguageId() {
      return this.language;
    }
    isDisposed() {
      return this.disposed;
    }
    dispose() {
      this.disposed = true;
      registry.delete(this.uri.toString());
    }
    setLanguage(language: string) {
      this.language = language;
    }
  }
  const monaco = {
    Uri: {
      file: (path: string) => ({ toString: () => `file://${path}` }),
      parse: (value: string) => ({ toString: () => value }),
    },
    editor: {
      getModel: (uri: { toString: () => string }) => registry.get(uri.toString()),
      createModel: (value: string, language: string, uri: { toString: () => string }) => {
        if (registry.has(uri.toString())) throw new Error("ModelService: model already exists");
        const model = new FakeMonacoModel(value, language, uri);
        registry.set(uri.toString(), model);
        return model;
      },
      setModelLanguage: (model: FakeMonacoModel, language: string) => model.setLanguage(language),
    },
  } as unknown as typeof Monaco;
  const workspace: FilesWorkspaceRef = { workspacePath: "/qa-monaco-model-dedupe" };
  const firstId = "legacy-buffer-id";
  const secondId = "canonical-buffer-id";
  try {
    const first = getOrCreateFilesMonacoModel(
      monaco,
      firstId,
      "export const value = 1;",
      "/qa-monaco-model-dedupe/src.ts",
      workspace,
    );
    const second = getOrCreateFilesMonacoModel(
      monaco,
      secondId,
      "export const value = 1;",
      "/qa-monaco-model-dedupe/src.ts",
      workspace,
    );
    assert.equal(second, first);
    assert.equal(registry.size, 1);
    disposeFilesMonacoModel(firstId);
    assert.equal(first.isDisposed(), false, "one buffer alias must not dispose a shared model");
    disposeFilesMonacoModel(secondId);
    assert.equal(first.isDisposed(), true);
    assert.equal(registry.size, 0);
  } finally {
    disposeFilesMonacoModel(firstId);
    disposeFilesMonacoModel(secondId);
  }
});
