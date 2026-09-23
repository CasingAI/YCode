import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPlanToolCallContent,
  getPlanDirectoryTitle,
  getPlanPathLabel,
  isPlanToolCallInputStreaming,
  shouldRenderCollapsedPlanCard,
  stripLeadingPlanTitleHeading,
} from "../src/lib/planToolCall.js";

// 折叠计划卡（参考 Cursor 的 Created Plan）从 ExitPlanMode 输入读 title/overview：
// 数据源仍是 transcript 工具行，不读落盘文件；卡片形态由调用状态决定，见下方用例。

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

// 路径不在 input/output 里：模型入参没有它，工具输出在 v4 的静默拒绝路径上根本不存在。
// 它是运行时落盘后经事件补齐的行级字段，提取时作为「所有来源都没有」的最后一档补上。

test("extractPlanToolCallContent：行级 planFilePath 补进内容，相对路径按 workspace 拼接", () => {
  const absolute = extractPlanToolCallContent(
    {
      input: { overview: "概述", plan: "# 计划", title: "计划" },
      planFilePath: "/workspace/.zcode/plans/s1/20260102-call-1.md",
    },
    "/workspace",
  );
  assert.equal(absolute.planFilePath, "/workspace/.zcode/plans/s1/20260102-call-1.md");
  assert.equal(absolute.markdown, "# 计划", "补路径不改正文来源与优先级");

  // 服务器下发相对路径时按同一 workspace 规则拼接
  const relative = extractPlanToolCallContent(
    { input: { plan: "# 计划" }, planFilePath: ".zcode/plans/s1/20260102-call-1.md" },
    "/workspace",
  );
  assert.equal(relative.planFilePath, "/workspace/.zcode/plans/s1/20260102-call-1.md");
});

test("extractPlanToolCallContent：legacy 节点从 raw 读路径；无正文或缺路径时都不给", () => {
  // toolCallRowAdapter 把行级字段放进 raw，老形态节点走这条路
  const viaRaw = extractPlanToolCallContent(
    { input: { plan: "# 计划" }, raw: { planFilePath: "/w/.zcode/plans/s1/a.md" } },
    "/w",
  );
  assert.equal(viaRaw.planFilePath, "/w/.zcode/plans/s1/a.md");

  // 服务器没下发路径（历史行）：字段缺席，卡片与面板逐项降级
  assert.equal(
    extractPlanToolCallContent({ input: { plan: "# 计划" } }, "/w").planFilePath,
    undefined,
  );
  // 没有正文就没有计划可展示，路径单独存在也不渲染
  assert.equal(
    extractPlanToolCallContent({ planFilePath: "/w/.zcode/plans/s1/a.md" }, "/w").planFilePath,
    undefined,
  );
});

// 卡片形态的判据：overview 是 schema 必填，定稿后必然存在，它的缺席只说明「还在流式」
// 或「该字段之前的旧调用」——两者必须分开，否则模型写计划的整段输出期都会是旧的全文预览。

test("isPlanToolCallInputStreaming：v4Status 与 inputPreviewComplete 两条线索都认", () => {
  assert.equal(isPlanToolCallInputStreaming({ raw: { v4Status: "inputStreaming" } }), true);
  // input 尚未解析时适配层给 inputPreviewComplete=false，status 可能停在别的中间态。
  assert.equal(isPlanToolCallInputStreaming({ raw: { inputPreviewComplete: false } }), true);
  assert.equal(
    isPlanToolCallInputStreaming({ raw: { v4Status: "success", inputPreviewComplete: true } }),
    false,
  );
  assert.equal(isPlanToolCallInputStreaming({}), false);
  assert.equal(isPlanToolCallInputStreaming({ raw: "legacy" }), false);
});

test("shouldRenderCollapsedPlanCard：流式缺 overview 也折叠，只有定稿的旧调用退回全文预览", () => {
  // 模型写计划期间：正文在、overview 还没流到，仍走折叠卡（少渲染概述行）。
  assert.equal(
    shouldRenderCollapsedPlanCard({ hasMarkdown: true, overview: undefined, streaming: true }),
    true,
  );
  // 定稿：schema 保证 overview 在场。
  assert.equal(
    shouldRenderCollapsedPlanCard({ hasMarkdown: true, overview: "概述", streaming: false }),
    true,
  );
  // 定稿且入参里确实没有 overview：overview 之前的旧计划，保持全文渐隐预览。
  assert.equal(
    shouldRenderCollapsedPlanCard({ hasMarkdown: true, overview: undefined, streaming: false }),
    false,
  );
  // 没有正文时两条分支都不成立。
  assert.equal(
    shouldRenderCollapsedPlanCard({ hasMarkdown: false, overview: "概述", streaming: true }),
    false,
  );
});

test("getPlanDirectoryTitle：折叠卡标题的提取回退（H1 优先，装饰行剥前缀）", () => {
  assert.equal(getPlanDirectoryTitle("# 标题\n正文"), "标题");
  assert.equal(getPlanDirectoryTitle("## 二级\n正文"), "二级");
  assert.equal(getPlanDirectoryTitle("> 引用开头"), "引用开头");
  assert.equal(getPlanDirectoryTitle(""), undefined);
});

// 详情面板路径行显示相对路径，绝对路径留在 tooltip 与复制动作上。

test("getPlanPathLabel：workspace 内给相对路径，workspace 外原样返回", () => {
  assert.equal(
    getPlanPathLabel("/repo/.zcode/plans/s1/2026.md", "/repo"),
    ".zcode/plans/s1/2026.md",
  );
  assert.equal(
    getPlanPathLabel("/repo/.zcode/plans/s1/2026.md", "/repo/"),
    ".zcode/plans/s1/2026.md",
  );
  // 只按目录前缀匹配：/repo-other 不是 /repo 的子路径。
  assert.equal(getPlanPathLabel("/repo-other/2026.md", "/repo"), "/repo-other/2026.md");
  assert.equal(getPlanPathLabel("/elsewhere/2026.md", undefined), "/elsewhere/2026.md");
  // workspace 根自身不是可显示的文件路径，退回原值而不是空串。
  assert.equal(getPlanPathLabel("/repo", "/repo"), "/repo");
});

test("stripLeadingPlanTitleHeading：只删与标题同名的首个 H1", () => {
  assert.equal(stripLeadingPlanTitleHeading("# 缓存验收\n\n正文", "缓存验收"), "\n正文");
  // 异名 H1 是正文自己的结构，保留。
  assert.equal(stripLeadingPlanTitleHeading("# 别的标题\n正文", "缓存验收"), "# 别的标题\n正文");
  // 标题缺席、或同名 H1 不在首个非空行时都不动。
  assert.equal(stripLeadingPlanTitleHeading("# 缓存验收\n正文", undefined), "# 缓存验收\n正文");
  assert.equal(
    stripLeadingPlanTitleHeading("前言\n\n# 缓存验收", "缓存验收"),
    "前言\n\n# 缓存验收",
  );
  // 正文不以 H1 开头（`#` 后无空格不是标题）。
  assert.equal(stripLeadingPlanTitleHeading("#缓存验收\n正文", "缓存验收"), "#缓存验收\n正文");
});
