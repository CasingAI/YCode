import assert from "node:assert/strict";
import test from "node:test";
import {
  configureFilesMonacoLanguageServices,
  FILES_MONACO_JSON_DIAGNOSTICS,
  FILES_MONACO_TS_DIAGNOSTICS,
} from "../src/files-workbench/filesMonacoLanguageServices.js";
import { filesMonacoLanguageFromPath } from "../src/files-workbench/filesMonacoLanguage.js";

test("关掉 TS/JS 语义诊断，JSON 允许注释和尾逗号", () => {
  const recorded: Record<string, unknown> = {};
  configureFilesMonacoLanguageServices({
    typescript: {
      typescriptDefaults: {
        setDiagnosticsOptions: (options) => {
          recorded.typescript = options;
        },
      },
      javascriptDefaults: {
        setDiagnosticsOptions: (options) => {
          recorded.javascript = options;
        },
      },
    },
    json: {
      jsonDefaults: {
        setDiagnosticsOptions: (options) => {
          recorded.json = options;
        },
      },
    },
  });
  assert.deepEqual(recorded.typescript, FILES_MONACO_TS_DIAGNOSTICS);
  assert.deepEqual(recorded.javascript, FILES_MONACO_TS_DIAGNOSTICS);
  assert.deepEqual(recorded.json, FILES_MONACO_JSON_DIAGNOSTICS);
});

test("tsconfig.json 仍按 json 高亮，由 JSONC 诊断选项允许注释", () => {
  assert.equal(filesMonacoLanguageFromPath("/tmp/a/tsconfig.json"), "json");
  assert.equal(filesMonacoLanguageFromPath("/tmp/a/src/app.ts"), "typescript");
});
