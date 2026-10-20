import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_EDITOR_LANGUAGE_POPULARITY_ORDER,
  compareFilesEditorLanguageIdsByPopularity,
  filesEditorLanguagePopularityRank,
} from "../src/files-workbench/filesEditorLanguagePopularity.js";

// 语言流行度排名表（docs/specs/files-editor-status-bar.md）。
// 这里只覆盖纯数据与纯函数：排名表自身的一致性，以及排序比较器的行为。

test("排名表：没有重复 id，排名与数组下标一致", () => {
  const ids = FILES_EDITOR_LANGUAGE_POPULARITY_ORDER;
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach((id, index) => {
    assert.equal(filesEditorLanguagePopularityRank(id), index);
  });
});

test("排名表：未收录的语言没有排名", () => {
  assert.equal(filesEditorLanguagePopularityRank("flow9"), undefined);
  assert.equal(filesEditorLanguagePopularityRank("msdax"), undefined);
});

test("比较器：有排名的语言在前，同档按 id 升序", () => {
  assert.ok(compareFilesEditorLanguageIdsByPopularity("typescript", "json") < 0);
  assert.ok(compareFilesEditorLanguageIdsByPopularity("json", "typescript") > 0);
  // 都没进排名表时退回首字母序。
  assert.ok(compareFilesEditorLanguageIdsByPopularity("flow9", "msdax") < 0);
  assert.ok(compareFilesEditorLanguageIdsByPopularity("msdax", "flow9") > 0);
  // 有排名的语言永远排在没排名的前面。
  assert.ok(compareFilesEditorLanguageIdsByPopularity("plaintext", "aaaplaceholder") < 0);
});
