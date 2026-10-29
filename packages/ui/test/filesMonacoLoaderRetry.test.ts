// 初始化失败重试测试：本包没有真实 Monaco 运行环境，用 TypeScript Compiler API
// 把 loader 源码转成 CommonJS，在函数作用域里注入假的 require 来观察实际加载次数。
// 产品规则见 docs/specs/workspace-large-text-files.md。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../src/files-workbench/filesMonacoLoader.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
});

interface LoaderHarness {
  loadFilesMonaco: () => Promise<unknown>;
  loadCount: () => number;
  configured: string[];
}

function createHarness(options?: { failMonacoLoads?: number }): LoaderHarness {
  let remainingFailures = options?.failMonacoLoads ?? 0;
  let loadCount = 0;
  const configured: string[] = [];
  const modules: Record<string, unknown> = {
    "./filesMonacoEnvironment.js": {},
    "monaco-editor": { editor: { create: () => undefined } },
    "@/files-workbench/filesMonacoLanguageServices.js": {
      configureFilesMonacoLanguageServices: () => configured.push("language"),
    },
    "@/files-workbench/filesMonacoCustomLanguages.js": {
      configureFilesMonacoCustomLanguages: () => configured.push("custom"),
    },
    "@/files-workbench/filesMonacoTypescriptCompiler.js": {
      configureFilesMonacoTypescriptCompiler: () => configured.push("typescript"),
    },
  };
  const requireModule = (id: string): unknown => {
    if (id === "monaco-editor") {
      loadCount += 1;
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("monaco load failed");
      }
    }
    const loaded = modules[id];
    assert.ok(loaded, `未预期的模块 ${id}`);
    return loaded;
  };
  const moduleExports: Record<string, unknown> = {};
  new Function("require", "exports", "module", outputText)(requireModule, moduleExports, {
    exports: moduleExports,
  });
  const loadFilesMonaco = moduleExports.loadFilesMonaco;
  assert.equal(typeof loadFilesMonaco, "function");
  return {
    loadFilesMonaco: loadFilesMonaco as () => Promise<unknown>,
    loadCount: () => loadCount,
    configured,
  };
}

test("并发调用共享同一个加载 Promise，只加载一次 Monaco", async () => {
  const harness = createHarness();
  const first = harness.loadFilesMonaco();
  const second = harness.loadFilesMonaco();
  assert.equal(first, second);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, secondResult);
  assert.equal(harness.loadCount(), 1);
  assert.deepEqual(harness.configured, ["language", "typescript", "custom"]);
});

test("初始化失败后再次调用真正重新加载，而不是复用 rejected Promise", async () => {
  const harness = createHarness({ failMonacoLoads: 1 });
  const failed = harness.loadFilesMonaco();
  await assert.rejects(failed, /monaco load failed/);
  assert.equal(harness.loadCount(), 1);

  const retry = harness.loadFilesMonaco();
  assert.notEqual(retry, failed);
  assert.ok(await retry);
  assert.equal(harness.loadCount(), 2);
  assert.deepEqual(harness.configured, ["language", "typescript", "custom"]);
});

test("成功后的加载 Promise 稳定缓存，后续调用不再触发加载", async () => {
  const harness = createHarness();
  const first = harness.loadFilesMonaco();
  const result = await first;

  const again = harness.loadFilesMonaco();
  assert.equal(again, first);
  assert.equal(await again, result);
  assert.equal(harness.loadCount(), 1);
  assert.equal(harness.configured.length, 3);
});
