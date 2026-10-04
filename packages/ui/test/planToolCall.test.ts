import assert from "node:assert/strict";
import test from "node:test";
import { buildZCodeStreamingToolInputPreview } from "@zcode/shared";
import {
  extractPlanToolCallContent,
  getPlanDirectoryTitle,
  getPlanPathLabel,
  isPlanToolCallInputStreaming,
  shouldRenderCollapsedPlanCard,
  stripLeadingPlanTitleHeading,
} from "../src/lib/planToolCall.js";

// 折叠计划卡（参考 Cursor 的 Created Plan）从计划工具输入读 title/overview：
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

test("extractPlanToolCallContent：只有 title/overview、正文还没流出时也照常解析", () => {
  // 计划工具按 title → overview → plan 顺序流出，流式早期正文还没到。
  // 这时必须已经能拿到标题与概述，否则卡片在整段输出期都无内容可渲染。
  const content = extractPlanToolCallContent(
    { input: { title: "缓存验收", overview: "收口缓存验收清单，不改代码。" } },
    "/workspace",
  );
  assert.equal(content.markdown, undefined);
  assert.equal(content.title, "缓存验收");
  assert.equal(content.overview, "收口缓存验收清单，不改代码。");
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
  // 模型写标题/概述期间：正文还没到，但卡片已经是折叠形态（有标题就能成形）。
  assert.equal(
    shouldRenderCollapsedPlanCard({
      hasMarkdown: false,
      hasTitleOrOverview: true,
      overview: undefined,
      streaming: true,
    }),
    true,
  );
  // 模型写计划正文期间：正文在、overview 还没流到，仍走折叠卡（少渲染概述行）。
  assert.equal(
    shouldRenderCollapsedPlanCard({
      hasMarkdown: true,
      hasTitleOrOverview: true,
      overview: undefined,
      streaming: true,
    }),
    true,
  );
  // 定稿：schema 保证 overview 在场。
  assert.equal(
    shouldRenderCollapsedPlanCard({
      hasMarkdown: true,
      hasTitleOrOverview: true,
      overview: "概述",
      streaming: false,
    }),
    true,
  );
  // 定稿且入参里确实没有 overview：overview 之前的旧计划，保持全文渐隐预览。
  assert.equal(
    shouldRenderCollapsedPlanCard({
      hasMarkdown: true,
      hasTitleOrOverview: false,
      overview: undefined,
      streaming: false,
    }),
    false,
  );
  // 三者皆无：连折叠卡都撑不起来。
  assert.equal(
    shouldRenderCollapsedPlanCard({
      hasMarkdown: false,
      hasTitleOrOverview: false,
      overview: undefined,
      streaming: true,
    }),
    false,
  );
});

test("getPlanDirectoryTitle：折叠卡标题的提取回退（H1 优先，装饰行剥前缀）", () => {
  assert.equal(getPlanDirectoryTitle("# 标题\n正文"), "标题");
  assert.equal(getPlanDirectoryTitle("## 二级\n正文"), "二级");
  assert.equal(getPlanDirectoryTitle("> 引用开头"), "引用开头");
  assert.equal(getPlanDirectoryTitle(""), undefined);
});

// 端到端回放一次真实调用的流式前缀。载荷形状与规模取自实测那次计划工具调用：正文近万字符、
// 以整句摘要开头（之后才是 H2），也就是「回退把整段话封成标题」最容易发生的形态。
// provider 可见的入参顺序是 title → overview → plan，模型照此流式吐 JSON。
const STREAMING_PLAN_BODY = [
  "把 `WebSearch` 从「provider 能力的转发壳」改成「真正执行搜索的客户端工具」。",
  "",
  "## 现状与根因",
  "",
  "仓库里现有的 `WebSearch` 名字上是个真工具，实现上不是：它把请求原样转发给 provider，",
  "真正的 HTTP 调用发生在 provider 侧，宿主对搜索引擎没有任何控制力。",
  "",
  "## 改动范围",
  "",
  ...Array.from(
    { length: 60 },
    (_, index) => `${index + 1}. 新增 provider 能力转发层与客户端工具层两条路径，二者互斥选择。`,
  ),
].join("\n");

const STREAMING_PLAN_INPUT = {
  title: "数据源分区与 WebSearch 搜索引擎工具",
  overview:
    "在设置页新增「数据源」分区管理 jina 与智谱两个搜索引擎（改 Key / 启停 / 标默认），宿主通过新增的 workspace/updateSearchEnginePolicy 协议命令把配置推给 agent；WebSearch 保留原生搜索作为互斥备选路径，并新增真正发 HTTP 请求的搜索引擎路径。",
  plan: STREAMING_PLAN_BODY,
};
// 实测那次是 78 个 delta / 10418 字符，均值约 134 字符一帧。
const STREAMING_DELTA_CHARS = 134;

/** 复刻折叠卡渲染层在流式期的取数与判据，返回用户实际看到的那张卡。 */
function renderStreamingPlanCard(rawInput: string) {
  const preview = buildZCodeStreamingToolInputPreview(rawInput);
  const content = extractPlanToolCallContent({ input: preview.input, inputText: rawInput }, "/w");
  const hasMarkdown = content.markdown !== undefined;
  const cardTitle =
    content.title ?? (content.markdown ? getPlanDirectoryTitle(content.markdown) : undefined);
  return {
    collapsed: shouldRenderCollapsedPlanCard({
      hasMarkdown,
      hasTitleOrOverview: content.title !== undefined || content.overview !== undefined,
      overview: content.overview,
      streaming: true,
    }),
    // 「查看」以正文为门禁：正文没到之前按钮不渲染。
    canView: hasMarkdown,
    title: cardTitle,
    overview: content.overview,
  };
}

test("流式回放：卡片在第一个标题片段就成形，且标题全程不回退成正文首行", () => {
  const raw = JSON.stringify(STREAMING_PLAN_INPUT);
  const frames: ReturnType<typeof renderStreamingPlanCard>[] = [];
  for (let end = 1; end <= raw.length; end += STREAMING_DELTA_CHARS) {
    frames.push(renderStreamingPlanCard(raw.slice(0, end)));
  }

  // 1. 空白窗口只有「连标题第一个字符都还没到」这几帧，不随正文长度增长。
  const blankFrames = frames.filter((frame) => !frame.collapsed);
  assert.ok(blankFrames.length <= 1, `正文前不应有长空白，实际 ${blankFrames.length} 帧`);

  // 2. 卡片一旦出现，标题就是显式 title 的前缀，且始终是它的前缀——
  //    绝不能中途变成 getPlanDirectoryTitle 抓到的正文首行。
  const firstVisible = frames.find((frame) => frame.collapsed);
  assert.ok(firstVisible, "标题片段到达后卡片必须立刻成形");
  for (const frame of frames.filter((candidate) => candidate.collapsed)) {
    assert.ok(
      STREAMING_PLAN_INPUT.title.startsWith(frame.title ?? ""),
      `标题中途变成了非显式值：${frame.title}`,
    );
  }

  // 3. 概述先于正文到齐：正文那近万字符还在流的时候，标题与概述已经定型。
  //    canView 的语义是「正文已经开始流」（详情面板能开、随流更新），不是「正文写完」。
  const bodyStartIndex = frames.findIndex((frame) => frame.canView);
  assert.ok(bodyStartIndex > 0, "正文应当晚于标题/概述到达");
  assert.equal(frames[bodyStartIndex]?.title, STREAMING_PLAN_INPUT.title);
  assert.equal(frames[bodyStartIndex]?.overview, STREAMING_PLAN_INPUT.overview);

  // 4. 正文流完为止，标题与概述一动不动——没有翻牌、没有抖动。
  for (const frame of frames.slice(bodyStartIndex)) {
    assert.equal(frame.title, STREAMING_PLAN_INPUT.title);
    assert.equal(frame.overview, STREAMING_PLAN_INPUT.overview);
    assert.equal(frame.collapsed, true);
  }
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
