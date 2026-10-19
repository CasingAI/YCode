import assert from "node:assert/strict";
import test from "node:test";
import {
  configureFilesMonacoCustomLanguages,
  FILES_MONACO_CUSTOM_LANGUAGE_IDS,
} from "../src/files-workbench/filesMonacoCustomLanguages.js";
import { filesMonacoLanguageFromPath } from "../src/files-workbench/filesMonacoLanguage.js";
import type * as Monaco from "monaco-editor";

test("语言识别覆盖常见代码、配置、脚本与扩展语法", () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, "plaintext"],
    ["/repo/src/main.MTS", "typescript"],
    ["C:\\repo\\src\\main.CTS", "typescript"],
    ["/repo/app.mjs", "javascript"],
    ["/repo/tsconfig.jsonc", "json"],
    ["/repo/data.jsonl", "jsonl"],
    ["/repo/data.NDJSON", "jsonl"],
    ["/repo/index.xhtml", "html"],
    ["/repo/readme.MDX", "markdown"],
    ["/repo/image.svg", "xml"],
    ["/repo/script.pyw", "python"],
    ["/repo/headers.hh", "cpp"],
    ["/repo/build.kts", "kotlin"],
    ["/repo/main.swift", "swift"],
    ["/repo/main.dart", "dart"],
    ["/repo/script.lua", "lua"],
    ["/repo/analysis.r", "r"],
    ["/repo/task.ps1", "powershell"],
    ["/repo/schema.proto", "protobuf"],
    ["/repo/service.gql", "graphql"],
    ["/repo/config.toml", "ini"],
    ["/repo/app.conf", "ini"],
  ];
  for (const [path, expected] of cases) {
    assert.equal(filesMonacoLanguageFromPath(path), expected, String(path));
  }
});

test("特殊文件名与点文件不会误判为普通扩展名", () => {
  const cases: Array<[string, string]> = [
    ["Dockerfile", "dockerfile"],
    ["/repo/Dockerfile.dev", "dockerfile"],
    ["Makefile", "makefile"],
    ["GNUmakefile", "makefile"],
    ["/repo/Makefile.test", "makefile"],
    [".env", "ini"],
    ["/repo/.env.production", "ini"],
    [".npmrc", "ini"],
    [".editorconfig", "ini"],
    [".bashrc", "shell"],
    [".envrc", "shell"],
    [".gitignore", "plaintext"],
    [".dockerignore", "plaintext"],
    ["README", "markdown"],
    ["CHANGELOG.md", "markdown"],
    ["unknown.abcxyz", "plaintext"],
    ["trailing.", "plaintext"],
  ];
  for (const [path, expected] of cases) {
    assert.equal(filesMonacoLanguageFromPath(path), expected, path);
  }
});

test("专用语言 ID 均有 Monaco tokenizer 与语言配置注册", () => {
  const calls: string[] = [];
  const registered: string[] = [];
  const fakeMonaco = {
    languages: {
      getLanguages: () => registered.map((id) => ({ id })),
      register: ({ id }: { id: string }) => {
        registered.push(id);
        calls.push(`register:${id}`);
      },
      setMonarchTokensProvider: (id: string) => calls.push(`tokens:${id}`),
      setLanguageConfiguration: (id: string) => calls.push(`config:${id}`),
    },
  } as unknown as typeof Monaco;

  configureFilesMonacoCustomLanguages(fakeMonaco);
  assert.deepEqual([...FILES_MONACO_CUSTOM_LANGUAGE_IDS].sort(), ["jsonl", "makefile"]);
  for (const id of FILES_MONACO_CUSTOM_LANGUAGE_IDS) {
    assert.ok(calls.includes(`register:${id}`));
    assert.ok(calls.includes(`tokens:${id}`));
    assert.ok(calls.includes(`config:${id}`));
  }
});
