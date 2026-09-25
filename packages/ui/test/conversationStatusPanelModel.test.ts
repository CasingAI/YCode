import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { resolvePlanDirectoryItemOverview } from "../src/app-shell/PlanDirectorySidePane.js";
import { buildSessionPlansModel } from "../src/v4/conversationStatusPanelModel.js";

function planRow(input: Record<string, unknown>): ToolCallRow {
  return {
    rowId: 1,
    toolCallId: "call_1",
    toolName: "ExitPlanMode",
    status: "success",
    input,
  } as unknown as ToolCallRow;
}

test("会话计划目录模型只把 overview 作为摘要来源", () => {
  const model = buildSessionPlansModel(
    [
      planRow({
        title: "优化计划目录",
        overview: "让目录保持紧凑，不展示计划正文。",
        plan: "# 优化计划目录\n\n这里是完整计划正文，包含实现步骤。",
      }),
    ],
    "/repo",
  );
  const item = model?.items[0];
  assert.equal(item?.title, "优化计划目录");
  assert.equal(item?.overview, "让目录保持紧凑，不展示计划正文。");
  assert.match(item?.markdown ?? "", /完整计划正文/);
});

test("会话计划目录模型在 overview 缺失时不从 markdown 推导摘要", () => {
  const model = buildSessionPlansModel(
    [
      planRow({
        title: "历史计划",
        plan: "# 历史计划\n\n这里只有正文，没有概述。",
      }),
    ],
    "/repo",
  );
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
