import assert from "node:assert/strict";
import test from "node:test";
import { hasElicitationDraftContent } from "../src/lib/elicitationDraftContent.js";

// 「忽略」会把这次提问判为未回答，草稿没有留存路径，所以草稿非空时必须先确认。
// 判据只认用户真的写过的内容：选中项或非空自定义输入。

test("空草稿不触发确认", () => {
  assert.equal(hasElicitationDraftContent({}), false);
  assert.equal(hasElicitationDraftContent({ "q-1": { selectedValues: [], customAnswer: "" } }), false);
  assert.equal(
    hasElicitationDraftContent({ "q-1": { selectedValues: [], customAnswer: "   " } }),
    false,
  );
});

test("选中选项或写下自定义答案都算有草稿", () => {
  assert.equal(
    hasElicitationDraftContent({ "q-1": { selectedValues: ["a"], customAnswer: "" } }),
    true,
  );
  assert.equal(
    hasElicitationDraftContent({ "q-1": { selectedValues: [], customAnswer: "长答案" } }),
    true,
  );
});

test("任意一题有草稿即需确认，缺失项不误判", () => {
  assert.equal(
    hasElicitationDraftContent({
      "q-1": { selectedValues: [], customAnswer: "" },
      "q-2": undefined,
      "q-3": { selectedValues: ["x"] },
    }),
    true,
  );
});
