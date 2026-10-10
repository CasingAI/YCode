import assert from "node:assert/strict";
import test from "node:test";
import type { V4ConversationPlanEntry } from "@zcode/shared/zcode-protocol-v4";
import { resolvePlanDirectoryItemOverview } from "../src/app-shell/PlanDirectorySidePane.js";
import {
  buildSessionPlansModel,
  shouldCoverSandboxConsoleAsDead,
  shouldRenderSandboxSection,
} from "../src/v4/conversationStatusPanelModel.js";

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

// 沙盒分区门控（阶段7/8主路径点检的逻辑面）：活实例存在性 + 会话上下文双闸。
// 面板出现 = 三者齐全；任一缺席即关门（实例死亡关门是重置后入口消失的那条链路）。
test("沙盒分区门控：三者齐全才开门，任一缺席即关门", () => {
  // 主路径：活实例在 + 有会话 + 有打开入口 → 面板出现。
  assert.equal(
    shouldRenderSandboxSection({
      parentSessionId: "sess_1",
      hasOpenHandler: true,
      sandboxAlive: true,
    }),
    true,
  );
  // 实例死亡（重置/dispose 后 sandboxStatus 回 unavailable）→ 关门。
  assert.equal(
    shouldRenderSandboxSection({
      parentSessionId: "sess_1",
      hasOpenHandler: true,
      sandboxAlive: false,
    }),
    false,
  );
  // 无会话上下文（目录/选择态）→ 不开门，避免无身份查询。
  assert.equal(
    shouldRenderSandboxSection({
      parentSessionId: null,
      hasOpenHandler: true,
      sandboxAlive: true,
    }),
    false,
  );
  // 无打开入口 → 不开门。
  assert.equal(
    shouldRenderSandboxSection({
      parentSessionId: "sess_1",
      hasOpenHandler: false,
      sandboxAlive: true,
    }),
    false,
  );
});

// 控制台死亡覆盖判定（阶段7/8主路径点检的逻辑面）：存在性查询已回且实例不在
// 即覆盖；首查未回前不盖；快照 alive:false 是兜底（双通道任一活着都不盖）。
test("沙盒控制台死亡覆盖：存在性关门即盖，首查未回不盖，快照兜底", () => {
  // 主路径：重置后存在性已回且不在 → 整页覆盖，只留关闭。
  assert.equal(
    shouldCoverSandboxConsoleAsDead({
      statusChecked: true,
      statusAlive: false,
      snapshotAlive: null,
    }),
    true,
  );
  // 活着 → 不盖。
  assert.equal(
    shouldCoverSandboxConsoleAsDead({
      statusChecked: true,
      statusAlive: true,
      snapshotAlive: true,
    }),
    false,
  );
  // 首查未回 → 不盖，避免加载闪覆盖。
  assert.equal(
    shouldCoverSandboxConsoleAsDead({
      statusChecked: false,
      statusAlive: false,
      snapshotAlive: null,
    }),
    false,
  );
  // 快照兜底：快照 alive:false 即盖（存在性抖动时仍能表达死亡）。
  assert.equal(
    shouldCoverSandboxConsoleAsDead({
      statusChecked: true,
      statusAlive: true,
      snapshotAlive: false,
    }),
    true,
  );
});
