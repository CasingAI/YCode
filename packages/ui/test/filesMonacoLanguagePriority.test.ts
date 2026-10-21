import assert from "node:assert/strict";
import test from "node:test";
import type * as Monaco from "monaco-editor";
import {
  applyFilesMonacoDetectedLanguage,
  disposeFilesMonacoModel,
  getFilesMonacoModelDetectedLanguage,
  getFilesMonacoModelExplicitLanguage,
  getOrCreateFilesMonacoModel,
  setFilesMonacoModelExplicitLanguage,
} from "../src/files-workbench/filesMonacoModels.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

/**
 * 模型上的语言有三种来源，优先级固定：
 * 用户显式选择 > 内容级检测结果 > 内置规则解析结果。
 * 这组用例守住优先级本身，以及检测结论在「模型复用」路径上的存活。
 */

class FakeMonacoModel {
  private disposed = false;
  private language: string;

  constructor(
    private readonly registry: Map<string, FakeMonacoModel>,
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
    this.registry.delete(this.uri.toString());
  }

  setLanguage(language: string) {
    this.language = language;
  }
}

function createFakeMonaco(): {
  monaco: typeof Monaco;
  registry: Map<string, FakeMonacoModel>;
} {
  const registry = new Map<string, FakeMonacoModel>();
  const monaco = {
    Uri: {
      file: (path: string) => ({ toString: () => `file://${path}` }),
      parse: (value: string) => ({ toString: () => value }),
    },
    editor: {
      getModel: (uri: { toString: () => string }) => registry.get(uri.toString()),
      createModel: (value: string, language: string, uri: { toString: () => string }) => {
        if (registry.has(uri.toString())) throw new Error("ModelService: model already exists");
        const model = new FakeMonacoModel(registry, value, language, uri);
        registry.set(uri.toString(), model);
        return model;
      },
      setModelLanguage: (model: FakeMonacoModel, language: string) => model.setLanguage(language),
    },
  } as unknown as typeof Monaco;
  return { monaco, registry };
}

const workspace: FilesWorkspaceRef = { workspacePath: "/qa-files-language-priority" };

test("内容级检测结论在正文编辑后不被兜底语言覆盖", () => {
  const { monaco } = createFakeMonaco();
  const id = "priority-detected";
  const path = "/qa-files-language-priority/mystery";
  try {
    const model = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "const answer = 42;",
      path,
      workspace,
      { languageId: "plaintext", source: "default" },
    );
    assert.equal(model.getLanguageId(), "plaintext", "内置规则没结论时先落兜底语言");

    // Worker 检测出结论，落到模型上。
    assert.equal(applyFilesMonacoDetectedLanguage(monaco, model, "typescript"), true);
    assert.equal(model.getLanguageId(), "typescript");

    // 用户改正文：模型复用路径会再次套用规则解析结果。
    const reused = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "const answer = 43;",
      path,
      workspace,
      { languageId: "plaintext", source: "default" },
    );
    assert.equal(reused, model);
    assert.equal(
      reused.getLanguageId(),
      "typescript",
      "编辑正文不得把内容级检测结论退回兜底语言",
    );
    assert.equal(getFilesMonacoModelDetectedLanguage(reused), "typescript");
  } finally {
    disposeFilesMonacoModel(id);
  }
});

test("内置规则有结论时内容级检测结论作废", () => {
  const { monaco } = createFakeMonaco();
  const id = "priority-rule-wins";
  const path = "/qa-files-language-priority/mystery-shebang";
  try {
    const model = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "const answer = 42;",
      path,
      workspace,
      { languageId: "plaintext", source: "default" },
    );
    applyFilesMonacoDetectedLanguage(monaco, model, "typescript");

    // 用户改了首行：规则链从「无结论」变成「有结论」，规则的证据比内容猜测强。
    const reused = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "#!/bin/bash\nls -la",
      path,
      workspace,
      { languageId: "shell", source: "first-line" },
    );
    assert.equal(reused.getLanguageId(), "shell");
    assert.equal(
      getFilesMonacoModelDetectedLanguage(reused),
      undefined,
      "规则有结论后内容级检测结论必须清掉",
    );
  } finally {
    disposeFilesMonacoModel(id);
  }
});

test("用户显式选定的语言覆盖内容级检测结论", () => {
  const { monaco } = createFakeMonaco();
  const id = "priority-explicit";
  const path = "/qa-files-language-priority/mystery-explicit";
  try {
    const model = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "const answer = 42;",
      path,
      workspace,
      { languageId: "plaintext", source: "default" },
    );
    applyFilesMonacoDetectedLanguage(monaco, model, "typescript");

    // 用户在状态栏手动选语言。
    setFilesMonacoModelExplicitLanguage(model, "python");
    monaco.editor.setModelLanguage(model, "python");
    assert.equal(
      getFilesMonacoModelDetectedLanguage(model),
      undefined,
      "显式选择后内容级检测结论作废",
    );

    // 之后到达的检测结论不得覆盖显式选择。
    assert.equal(applyFilesMonacoDetectedLanguage(monaco, model, "ruby"), false);
    assert.equal(model.getLanguageId(), "python");

    const reused = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "print(1)",
      path,
      workspace,
      { languageId: "plaintext", source: "default" },
    );
    assert.equal(reused.getLanguageId(), "python", "显式选择不被推断结果覆盖");
  } finally {
    disposeFilesMonacoModel(id);
  }
});

test("模型销毁后显式选择与检测结论一并清理", () => {
  const { monaco } = createFakeMonaco();
  const id = "priority-dispose";
  const path = "/qa-files-language-priority/mystery-dispose";
  try {
    const model = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "const answer = 42;",
      path,
      workspace,
      { languageId: "plaintext", source: "default" },
    );
    applyFilesMonacoDetectedLanguage(monaco, model, "typescript");
    setFilesMonacoModelExplicitLanguage(model, "python");

    disposeFilesMonacoModel(id);

    assert.equal(model.isDisposed(), true);
    assert.equal(getFilesMonacoModelDetectedLanguage(model), undefined);
    assert.equal(getFilesMonacoModelExplicitLanguage(model), undefined);
  } finally {
    disposeFilesMonacoModel(id);
  }
});

test("没有检测结论时按规则解析结果套用语言", () => {
  const { monaco } = createFakeMonaco();
  const id = "priority-rule-only";
  const path = "/qa-files-language-priority/src/app.ts";
  try {
    const model = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "const a = 1;",
      path,
      workspace,
      { languageId: "typescript", source: "extension" },
    );
    assert.equal(model.getLanguageId(), "typescript");

    const reused = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "const a = 2;",
      path,
      workspace,
      { languageId: "typescript", source: "extension" },
    );
    assert.equal(reused.getLanguageId(), "typescript");
  } finally {
    disposeFilesMonacoModel(id);
  }
});

test("未传语言时按路径推断，既有调用点仍可用", () => {
  const { monaco } = createFakeMonaco();
  const id = "priority-no-language";
  try {
    const model = getOrCreateFilesMonacoModel(
      monaco,
      id,
      "const a = 1;",
      "/qa-files-language-priority/src/app.ts",
      workspace,
    );
    assert.equal(model.getLanguageId(), "typescript");
  } finally {
    disposeFilesMonacoModel(id);
  }
});
