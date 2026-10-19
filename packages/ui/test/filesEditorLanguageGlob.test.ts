import assert from "node:assert/strict";
import test from "node:test";
import {
  filesEditorGlobMatches,
  isFilesEditorGlobPattern,
  normalizeFilesEditorPath,
} from "../src/files-workbench/filesEditorLanguageGlob.js";

test("不含分隔符的模式只匹配文件名", () => {
  assert.equal(filesEditorGlobMatches("*.foo", "app.foo"), true);
  assert.equal(filesEditorGlobMatches("*.foo", "src/app.foo"), true);
  assert.equal(filesEditorGlobMatches("*.foo", "src/app.bar"), false);
  assert.equal(filesEditorGlobMatches("*.foo", "src/app.foo.bak"), false);
});

test("含分隔符的模式匹配整条路径", () => {
  assert.equal(filesEditorGlobMatches("src/*.foo", "src/app.foo"), true);
  assert.equal(filesEditorGlobMatches("src/*.foo", "lib/app.foo"), false);
  assert.equal(filesEditorGlobMatches("src/**/*.foo", "src/a/b/app.foo"), true);
  assert.equal(filesEditorGlobMatches("src/**/*.foo", "src/app.foo"), true);
  assert.equal(filesEditorGlobMatches("src/**/*.foo", "lib/app.foo"), false);
});

test("单字符通配只匹配一个非分隔符字符", () => {
  assert.equal(filesEditorGlobMatches("a?c.txt", "abc.txt"), true);
  assert.equal(filesEditorGlobMatches("a?c.txt", "abbc.txt"), false);
  assert.equal(filesEditorGlobMatches("a?c.txt", "a/c.txt"), false);
});

test("通配匹配忽略大小写并兼容反斜杠路径", () => {
  assert.equal(filesEditorGlobMatches("*.FOO", "app.foo"), true);
  assert.equal(filesEditorGlobMatches("src\\*.foo", "src/app.foo"), true);
});

test("路径归一化统一分隔符并转小写", () => {
  assert.equal(normalizeFilesEditorPath("C:\\Repo\\Src\\App.TS"), "c:/repo/src/app.ts");
  assert.equal(normalizeFilesEditorPath("/Repo/App.ts"), "/repo/app.ts");
});

test("带通配符的键才算模式", () => {
  assert.equal(isFilesEditorGlobPattern("*.foo"), true);
  assert.equal(isFilesEditorGlobPattern("/repo/app.foo"), false);
  assert.equal(isFilesEditorGlobPattern("app?.foo"), true);
});
