import assert from "node:assert/strict";
import test from "node:test";
import { rewriteSandboxImports } from "../src/sandbox/rewrite-sandbox-imports.js";

test("静态 import 加顶层 return 改写成 require，原文 return 仍在", () => {
  const rewritten = rewriteSandboxImports(`import fs from "fs";\nreturn String(fs === require("fs"));`);
  assert.match(rewritten, /require\("fs"\)/);
  assert.equal(rewritten.includes("import fs from"), false);
  assert.match(rewritten, /return String\(fs === require\("fs"\)\)/);
});

test("命名 import 与 namespace import 都落到 require", () => {
  const named = rewriteSandboxImports(`import { promises as fsp } from "fs";\nreturn fsp;`);
  assert.match(named, /const \{ promises: fsp \} = require\("fs"\)/);
  assert.equal(named.includes("import {"), false);
  const namespace = rewriteSandboxImports(`import * as path from "path";\nreturn path.join("a", "b");`);
  assert.match(namespace, /const path = require\("path"\)/);
  assert.equal(namespace.includes("import *"), false);
});

test("动态 import() 改成 Promise 再 require，未知 id 同样改写", () => {
  const allowed = rewriteSandboxImports(`const m = await import("fs");\nreturn m;`);
  assert.match(allowed, /Promise\.resolve\(\)\.then\(\(\) => require\("fs"\)\)/);
  assert.equal(allowed.includes('import("fs")'), false);
  const unknown = rewriteSandboxImports(`try { await import("os"); return "ok"; } catch (e) { return e.code; }`);
  assert.match(unknown, /require\("os"\)/);
  assert.equal(unknown.includes('import("os")'), false);
});

test("没有 import 的源码原样返回", () => {
  const source = `const x = 1;\nreturn x;`;
  assert.equal(rewriteSandboxImports(source), source);
});
