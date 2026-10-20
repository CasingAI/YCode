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
  assert.equal(filesEditorLanguagePopularityRank("not-a-registered-language"), undefined);
  assert.equal(filesEditorLanguagePopularityRank("aaaplaceholder"), undefined);
});

test("排名表：常用语言按仓库覆盖率排在前面", () => {
  const rank = (id: string) => filesEditorLanguagePopularityRank(id)!;
  // 覆盖率量级差异明显，抽样波动不会翻转这几对的先后。
  assert.ok(rank("markdown") < rank("yaml"));
  assert.ok(rank("yaml") < rank("json"));
  assert.ok(rank("json") < rank("javascript"));
  assert.ok(rank("javascript") < rank("typescript"));
  assert.ok(rank("typescript") < rank("makefile"));
  assert.ok(rank("makefile") < rank("c"));
});

test("排名表：别名语言共享同一份额", () => {
  // 产品规则里用的是 Monaco 的别名 id（coffee / protobuf / solidity）。
  assert.equal(
    filesEditorLanguagePopularityRank("coffee"),
    filesEditorLanguagePopularityRank("coffeescript"),
  );
  assert.equal(
    filesEditorLanguagePopularityRank("protobuf"),
    filesEditorLanguagePopularityRank("proto"),
  );
  assert.equal(
    filesEditorLanguagePopularityRank("solidity"),
    filesEditorLanguagePopularityRank("sol"),
  );
});

test("比较器：有排名的语言在前，同档按 id 升序", () => {
  assert.ok(compareFilesEditorLanguageIdsByPopularity("json", "typescript") < 0);
  assert.ok(compareFilesEditorLanguageIdsByPopularity("typescript", "json") > 0);
  // 都没进排名表时退回首字母序。
  assert.ok(compareFilesEditorLanguageIdsByPopularity("aaaplaceholder", "zzzplaceholder") < 0);
  assert.ok(compareFilesEditorLanguageIdsByPopularity("zzzplaceholder", "aaaplaceholder") > 0);
  // 有排名的语言永远排在没排名的前面。
  assert.ok(compareFilesEditorLanguageIdsByPopularity("plaintext", "aaaplaceholder") < 0);
});
