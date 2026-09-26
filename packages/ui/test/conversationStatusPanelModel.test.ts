import assert from "node:assert/strict";
import test from "node:test";
import type { V4ConversationPlanEntry } from "@zcode/shared/zcode-protocol-v4";
import { resolvePlanDirectoryItemOverview } from "../src/app-shell/PlanDirectorySidePane.js";
import { buildSessionPlansModel } from "../src/v4/conversationStatusPanelModel.js";

/** 造一条目录项 = 一份计划文件。 */
function planEntry(input: {
  planId: string;
  markdown?: string;
  title?: string;
  overview?: string;
  createdAt?: string;
  toolCallId?: string;
}): V4ConversationPlanEntry {
  return {
    planId: input.planId,
    planFilePath: `/repo/.zcode/plans/sess_1/${input.planId}.md`,
    markdown: input.markdown ?? `# ${input.planId}`,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.overview === undefined ? {} : { overview: input.overview }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
  };
}

test("会话计划目录模型只把 overview 作为摘要来源", () => {
  const model = buildSessionPlansModel([
    planEntry({
      planId: "a",
      title: "优化计划目录",
      overview: "让目录保持紧凑，不展示计划正文。",
      markdown: "# 优化计划目录\n\n这里是完整计划正文，包含实现步骤。",
    }),
  ]);
  const item = model?.items[0];
  assert.equal(item?.title, "优化计划目录");
  assert.equal(item?.overview, "让目录保持紧凑，不展示计划正文。");
  assert.match(item?.markdown ?? "", /完整计划正文/);
});

test("会话计划目录模型在 overview 缺失时不从 markdown 推导摘要", () => {
  const model = buildSessionPlansModel([
    planEntry({
      planId: "a",
      title: "历史计划",
      markdown: "# 历史计划\n\n这里只有正文，没有概述。",
    }),
  ]);
  const item = model?.items[0];
  assert.equal(item?.title, "历史计划");
  assert.equal(item?.overview, undefined);
});

test("计划目录项摘要只解析 overview，不回退 markdown 正文", () => {
  const itemWithOverview = {
    overview: "  短概述  ",
    markdown: "这里是完整计划正文",
  };
  const itemWithoutOverview = {
    markdown: "这里是完整计划正文",
  };
  assert.equal(resolvePlanDirectoryItemOverview(itemWithOverview), "短概述");
  assert.equal(resolvePlanDirectoryItemOverview(itemWithoutOverview), undefined);
});

test("会话计划目录模型：一条文件一条目录项，不筛选也不重排", () => {
  // 顺序就是协议给的顺序（CLI 已排好），这里原样透传——重排只会在两端制造分歧。
  const model = buildSessionPlansModel([
    planEntry({ planId: "c", title: "最新" }),
    planEntry({ planId: "a", title: "最旧" }),
    planEntry({ planId: "b", title: "居中" }),
  ]);
  assert.deepEqual(
    model?.items.map((item) => item.planId),
    ["c", "a", "b"],
  );
});

test("会话计划目录模型：空与缺席都返回 null，让状态面板分区整体不出现", () => {
  assert.equal(buildSessionPlansModel(undefined), null);
  assert.equal(buildSessionPlansModel([]), null);
});

test("会话计划目录模型：没有 toolCallId 的历史计划文件照常成项", () => {
  const model = buildSessionPlansModel([planEntry({ planId: "legacy", title: "历史计划" })]);
  const item = model?.items[0];
  assert.equal(item?.planId, "legacy");
  assert.equal(item?.toolCallId, undefined);
  assert.equal(item?.createdAt, undefined);
  assert.ok(item?.markdown);
});
