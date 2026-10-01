import assert from "node:assert/strict";
import test from "node:test";
import type { PlanState } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationStatusPanelModel,
  planProgressLabel,
  planProgressPercent,
} from "../src/v4/conversationStatusPanelModel.js";

/**
 * 造一份 plan：`status` 用协议的三态（pending / inProgress / completed）。
 * 这里只喂计数需要的形状，不复用生产侧 `buildPlanModel`（那是待测的下游）。
 */
function planOf(statuses: PlanState["items"][number]["status"][]) {
  return {
    items: statuses.map((status, index) => ({
      content: `第 ${index + 1} 项`,
      status,
    })),
  } as PlanState;
}

test("Todo 进度百分比按完成项 / 总项计算", () => {
  const model = buildConversationStatusPanelModel({
    plan: planOf(["completed", "pending", "pending", "pending"]),
  });
  assert.equal(planProgressPercent(model.plan), 25);
});

test("Todo 进度百分比：全部完成是满环，单项列表也是满环", () => {
  const allDone = buildConversationStatusPanelModel({ plan: planOf(["completed", "completed"]) });
  assert.equal(planProgressPercent(allDone.plan), 100);
  // 单待办列表首次渲染就是完成态，这里必须是 100 而不是除零。
  const singleDone = buildConversationStatusPanelModel({ plan: planOf(["completed"]) });
  assert.equal(planProgressPercent(singleDone.plan), 100);
});

test("Todo 进度百分比：空计划与缺席 plan 都返回 0，不产生 NaN", () => {
  assert.equal(planProgressPercent(null), 0);
  assert.equal(planProgressPercent(buildConversationStatusPanelModel({}).plan), 0);
  assert.equal(
    planProgressPercent(buildConversationStatusPanelModel({ plan: planOf([]) }).plan),
    0,
  );
});

test("Todo 进度百分比：进行中的列表是 0，inProgress 不算完成", () => {
  const model = buildConversationStatusPanelModel({
    plan: planOf(["inProgress", "pending", "pending"]),
  });
  assert.equal(planProgressPercent(model.plan), 0);
});

test("面板读数：未完成时给出取整百分比与剩余个数", () => {
  const model = buildConversationStatusPanelModel({
    plan: planOf(["completed", "pending", "pending", "pending", "pending", "pending", "pending"]),
  });
  // 1/7 = 14.28…%，面板取整到 14，剩 6 个。
  assert.deepEqual(planProgressLabel(model.plan), { percent: 14, remaining: 6 });
});

test("面板读数：全部完成返回 null，让渲染层说「已完成」而不是「剩 0 个」", () => {
  const done = buildConversationStatusPanelModel({
    plan: planOf(["completed", "completed", "completed"]),
  });
  assert.equal(planProgressLabel(done.plan), null);
  // 单项列表首次渲染就是完成态，同样不该报「剩 0 个」。
  const single = buildConversationStatusPanelModel({ plan: planOf(["completed"]) });
  assert.equal(planProgressLabel(single.plan), null);
});

test("面板读数：空计划与缺席 plan 都返回 null，不产生 NaN 文案", () => {
  assert.equal(planProgressLabel(null), null);
  assert.equal(planProgressLabel(buildConversationStatusPanelModel({}).plan), null);
  assert.equal(
    planProgressLabel(buildConversationStatusPanelModel({ plan: planOf([]) }).plan),
    null,
  );
});

test("面板读数：完成数为 0 时报 0% 与全部剩余", () => {
  const model = buildConversationStatusPanelModel({ plan: planOf(["pending", "pending"]) });
  assert.deepEqual(planProgressLabel(model.plan), { percent: 0, remaining: 2 });
});

test("Todo 计数与胶囊圆环同源：面板读到的完成数就是圆环读数", () => {
  const model = buildConversationStatusPanelModel({
    plan: planOf(["completed", "completed", "inProgress", "pending"]),
  });
  const completed = model.plan?.items.filter((item) => item.status === "completed").length ?? 0;
  assert.equal(completed, 2);
  assert.equal(model.plan?.completedCount, completed);
  assert.equal(planProgressPercent(model.plan), (completed / (model.plan?.totalCount ?? 0)) * 100);
});

/**
 * 穷举 plan item 的全部 status 组合，断言胶囊优先级链永远落得到具体项上。
 *
 * 这条锁住的是「胶囊里那支 `进程 n/m` 已删除」这个事实：它曾要求 `currentPlanItem`
 * 与 `completedPlanItem` 同时为空，而 `planItemSchema` 的 status 只有三个值、
 * `buildPlanModel` 又在空计划时返回 null，所以 plan 非空时必然至少有一项被前两支命中。
 * 删掉那支之后，这条不变量就是它的可执行替代品——真有人再加回来，这里会红。
 */
test("穷举：plan 非空时胶囊总能落到进行中项或已完成项，不存在「有 plan 却无项可报」", () => {
  const statuses = ["pending", "inProgress", "completed"] as const;
  const combos = (n: number): (typeof statuses)[number][][] => {
    if (n === 0) return [[]];
    return statuses.flatMap((s) => combos(n - 1).map((rest) => [s, ...rest]));
  };

  let checked = 0;
  for (let n = 1; n <= 5; n++) {
    for (const combo of combos(n)) {
      const model = buildConversationStatusPanelModel({ plan: planOf(combo) });
      const plan = model.plan;
      if (plan === null) continue;
      const current =
        plan.items.find((item) => item.status === "inProgress") ??
        plan.items.find((item) => item.status === "pending") ??
        null;
      const completed =
        [...plan.items].reverse().find((item) => item.status === "completed") ?? null;
      // 两支都落空才是被删掉那支的条件；穷举证明它一次都不会发生。
      assert.ok(
        current !== null || completed !== null,
        `n=${n} ${combo.join(",")} 既没有进行中项也没有已完成项`,
      );
      checked++;
    }
  }
  // 3 + 9 + 27 + 81 + 243 = 363，与 spec 里写的穷举规模一致。
  assert.equal(checked, 363);
});
