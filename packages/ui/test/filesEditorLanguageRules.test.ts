import assert from "node:assert/strict";
import test from "node:test";
import {
  filesEditorFirstLine,
  resolveFilesEditorLanguage,
} from "../src/files-workbench/filesEditorLanguage.js";
import {
  FILES_MONACO_LANGUAGE_OPTIONS,
  filesMonacoLanguageMatchFromPath,
} from "../src/files-workbench/filesMonacoLanguage.js";
import { filesEditorLanguagePopularityRank } from "../src/files-workbench/filesEditorLanguagePopularity.js";

test("内置规则按文件名 → 模式 → 扩展名 → 首行依次命中", () => {
  assert.deepEqual(filesMonacoLanguageMatchFromPath("/repo/Dockerfile"), {
    languageId: "dockerfile",
    source: "filename",
  });
  assert.deepEqual(filesMonacoLanguageMatchFromPath("/repo/tsconfig.app.json"), {
    languageId: "json",
    source: "filename-pattern",
  });
  assert.deepEqual(filesMonacoLanguageMatchFromPath("/repo/src/app.ts"), {
    languageId: "typescript",
    source: "extension",
  });
  assert.deepEqual(filesMonacoLanguageMatchFromPath("/repo/run", "#!/bin/bash"), {
    languageId: "shell",
    source: "first-line",
  });
  assert.deepEqual(filesMonacoLanguageMatchFromPath("/repo/run"), {
    languageId: "plaintext",
    source: "default",
  });
});

test("扩展名优先于首行规则", () => {
  // 文件名的证据强于 shebang：与 VS Code 的优先级一致。
  assert.deepEqual(filesMonacoLanguageMatchFromPath("/repo/notes.txt", "#!/bin/bash"), {
    languageId: "plaintext",
    source: "extension",
  });
});

test("首行规则识别常见解释器", () => {
  const cases: Array<[string, string]> = [
    ["#!/usr/bin/env python3", "python"],
    ["#!/usr/bin/python", "python"],
    ["#!/usr/bin/env node", "javascript"],
    ["#!/usr/bin/env deno", "typescript"],
    ["#!/usr/bin/env bun", "javascript"],
    ["#!/bin/zsh", "shell"],
    ["#!/usr/bin/env ruby", "ruby"],
    ["#!/usr/bin/env perl", "perl"],
    ["#!/usr/bin/env php", "php"],
  ];
  for (const [firstLine, expected] of cases) {
    assert.deepEqual(filesMonacoLanguageMatchFromPath("/repo/script", firstLine), {
      languageId: expected,
      source: "first-line",
    });
  }
});

test("首行不是 shebang 时不误判", () => {
  assert.deepEqual(filesMonacoLanguageMatchFromPath("/repo/script", "hello world"), {
    languageId: "plaintext",
    source: "default",
  });
});

test("无路径时只用首行", () => {
  assert.deepEqual(filesMonacoLanguageMatchFromPath(undefined, "#!/bin/sh"), {
    languageId: "shell",
    source: "first-line",
  });
  assert.deepEqual(filesMonacoLanguageMatchFromPath(undefined), {
    languageId: "plaintext",
    source: "default",
  });
});

test("用户关联优先于内置规则", () => {
  const associations = { "*.foo": "typescript" };
  assert.deepEqual(resolveFilesEditorLanguage({ path: "/repo/src/app.foo", associations }), {
    languageId: "typescript",
    source: "user-pattern",
  });
  // 内置规则命中扩展名时，用户关联仍然优先。
  assert.deepEqual(
    resolveFilesEditorLanguage({ path: "/repo/src/app.ts", associations: { "*.ts": "plaintext" } }),
    { languageId: "plaintext", source: "user-pattern" },
  );
});

test("用户关联按路径命中时标记为 user-file", () => {
  const associations = { "/repo/src/app.foo": "typescript" };
  assert.deepEqual(resolveFilesEditorLanguage({ path: "/repo/src/app.foo", associations }), {
    languageId: "typescript",
    source: "user-file",
  });
  // 路径键不命中其它同名文件。
  assert.deepEqual(resolveFilesEditorLanguage({ path: "/repo/src/other.foo", associations }), {
    languageId: "plaintext",
    source: "default",
  });
});

test("无用户关联时走内置规则", () => {
  assert.deepEqual(resolveFilesEditorLanguage({ path: "/repo/src/app.ts" }), {
    languageId: "typescript",
    source: "extension",
  });
});

test("取首行时忽略空内容与行尾回车", () => {
  assert.equal(filesEditorFirstLine("#!/bin/bash\nfoo"), "#!/bin/bash");
  assert.equal(filesEditorFirstLine("#!/bin/bash\r\nfoo"), "#!/bin/bash");
  assert.equal(filesEditorFirstLine(""), undefined);
  assert.equal(filesEditorFirstLine(undefined), undefined);
  // 首行为空行时没有可用的首行。
  assert.equal(filesEditorFirstLine("\nfoo"), undefined);
});

test("设置页语言选项按流行度排序", () => {
  const options = FILES_MONACO_LANGUAGE_OPTIONS;
  const indexOf = (id: string) => options.indexOf(id);
  assert.ok(indexOf("typescript") >= 0);
  // 常用语言按仓库覆盖率排在前面。
  assert.ok(indexOf("markdown") < indexOf("json"));
  assert.ok(indexOf("json") < indexOf("typescript"));
  assert.ok(indexOf("typescript") < indexOf("coffee"));
  // 全部选项都有份额数据，排在末尾的是份额最低的那个。
  const tailId = options[options.length - 1]!;
  const tailRank = filesEditorLanguagePopularityRank(tailId);
  assert.notEqual(tailRank, undefined);
  for (const option of options) {
    const rank = filesEditorLanguagePopularityRank(option);
    assert.notEqual(rank, undefined);
    assert.ok(rank! <= tailRank!);
  }
});
