import assert from "node:assert/strict";
import test from "node:test";
import { extractPlanToolCallContent, getPlanDirectoryTitle } from "../src/lib/planToolCall.js";

// 折叠计划卡（参考 Cursor 的 Created Plan）从 ExitPlanMode 输入读 title/overview：
// 数据源仍是 transcript 工具行，不读落盘文件；没有 overview 时卡片回退历史全文预览渲染。

test("extractPlanToolCallContent：读取输入里的 title 与 overview", () => {
  const content = extractPlanToolCallContent(
    {
      input: {
        overview: "收口缓存验收清单，不改代码。",
        plan: "# 缓存验收\n正文",
        title: "缓存验收",
      },
    },
    "/workspace",
  );
  assert.equal(content.markdown, "# 缓存验收\n正文");
  assert.equal(content.title, "缓存验收");
  assert.equal(content.overview, "收口缓存验收清单，不改代码。");
});

test("extractPlanToolCallContent：无 title/overview 时字段缺席，markdown 照常", () => {
  const content = extractPlanToolCallContent({ input: { plan: "# 旧计划" } }, "/workspace");
  assert.equal(content.markdown, "# 旧计划");
  assert.equal(content.title, undefined);
  assert.equal(content.overview, undefined);
  assert.equal(content.planFilePath, undefined);
});

test("extractPlanToolCallContent：inputText 与 legacy raw 链路同样带出 title/overview", () => {
  const viaInputText = extractPlanToolCallContent(
    { inputText: JSON.stringify({ overview: "概述", plan: "# 计划" }) },
    "/workspace",
  );
  assert.equal(viaInputText.markdown, "# 计划");
  assert.equal(viaInputText.overview, "概述");

  const viaRaw = extractPlanToolCallContent(
    { raw: { rawInput: { overview: "raw 概述", plan: "# 计划" } } },
    "/workspace",
  );
  assert.equal(viaRaw.overview, "raw 概述");
});

test("getPlanDirectoryTitle：折叠卡标题的提取回退（H1 优先，装饰行剥前缀）", () => {
  assert.equal(getPlanDirectoryTitle("# 标题\n正文"), "标题");
  assert.equal(getPlanDirectoryTitle("## 二级\n正文"), "二级");
  assert.equal(getPlanDirectoryTitle("> 引用开头"), "引用开头");
  assert.equal(getPlanDirectoryTitle(""), undefined);
});
