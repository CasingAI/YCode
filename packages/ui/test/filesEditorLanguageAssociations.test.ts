import assert from "node:assert/strict";
import test from "node:test";
import {
  filesEditorAssociationPatternForPath,
  matchFilesEditorAssociation,
} from "../src/files-workbench/filesEditorLanguageAssociations.js";

test("模式关联命中任意目录下的同后缀文件", () => {
  const match = matchFilesEditorAssociation({ "*.foo": "typescript" }, "/repo/src/app.foo");
  assert.deepEqual(match, { languageId: "typescript", key: "*.foo", kind: "pattern" });
});

test("路径关联只命中该路径", () => {
  const associations = { "/repo/src/app.foo": "typescript" };
  assert.deepEqual(matchFilesEditorAssociation(associations, "/repo/src/app.foo"), {
    languageId: "typescript",
    key: "/repo/src/app.foo",
    kind: "file",
  });
  assert.equal(matchFilesEditorAssociation(associations, "/repo/src/other.foo"), undefined);
});

test("路径关联优先于模式关联", () => {
  const associations = { "*.foo": "javascript", "/repo/src/app.foo": "typescript" };
  assert.deepEqual(matchFilesEditorAssociation(associations, "/repo/src/app.foo"), {
    languageId: "typescript",
    key: "/repo/src/app.foo",
    kind: "file",
  });
});

test("同类关联取更长的键", () => {
  const associations = { "*.foo": "javascript", "*.special.foo": "typescript" };
  assert.deepEqual(matchFilesEditorAssociation(associations, "/repo/src/app.special.foo"), {
    languageId: "typescript",
    key: "*.special.foo",
    kind: "pattern",
  });
});

test("路径匹配忽略大小写与分隔符差异", () => {
  const associations = { "C:\\Repo\\src\\App.foo": "typescript" };
  assert.equal(
    matchFilesEditorAssociation(associations, "c:/repo/src/app.foo")?.languageId,
    "typescript",
  );
});

test("没有关联表或没有路径时不匹配", () => {
  assert.equal(matchFilesEditorAssociation(undefined, "/repo/app.foo"), undefined);
  assert.equal(matchFilesEditorAssociation({ "*.foo": "typescript" }, undefined), undefined);
});

test("按模式保存时用 *.<扩展名> 作为键", () => {
  assert.equal(filesEditorAssociationPatternForPath("/repo/src/app.foo"), "*.foo");
  assert.equal(filesEditorAssociationPatternForPath("C:\\repo\\src\\App.TS"), "*.ts");
  // 无扩展名时退回文件名本身（此时是精确键）。
  assert.equal(filesEditorAssociationPatternForPath("/repo/run"), "run");
});
