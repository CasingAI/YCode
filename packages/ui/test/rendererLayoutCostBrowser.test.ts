import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { loadChromium } from "./helpers/chromiumFixture.js";
import {
  buildCoverage,
  coverageProblems,
  planMatrix,
} from "./helpers/rendererLayoutCostCoverage.js";
import {
  runRendererLayoutCostMatrix,
  summarizeRendererLayoutCost,
  validateRendererLayoutCost,
} from "./helpers/rendererLayoutCostHarness.js";
import { RENDERER_LAYOUT_COST_SCENARIOS } from "./helpers/rendererLayoutCostScenarios.js";
import {
  loadPrechangeSnapshot,
  resolveManifestPath,
} from "./helpers/rendererLayoutCostSnapshot.js";
import {
  summarizeInteractionTiming,
  summarizeLongTasks,
} from "./helpers/rendererLayoutCostSummary.js";

// Renderer 交互布局成本对照（docs/specs/renderer-interaction-layout-cost.md）。
//
// 缺 manifest / 独立 Chromium 时整段浏览器用例显式 skip，不写成通过。
// 冒烟必须显式 YCODE_RENDERER_LAYOUT_COST_SMOKE=1，只验证 harness 接线；
// 正式矩阵要求每 case warmup 1 + measured 5，且不得静默剔除 surface。

test("EventTiming 只认 interactionId>0，缺失保持 null，presentation 标记为估计", () => {
  const onlyNonInteraction = summarizeInteractionTiming(
    [
      {
        name: "pointerover",
        startTime: 10,
        duration: 120,
        interactionId: 0,
        processingStart: 20,
        processingEnd: 60,
      },
    ],
    true,
  );
  assert.equal(onlyNonInteraction.rawEntries, 1);
  assert.equal(onlyNonInteraction.interactionEntries, 0);
  assert.equal(onlyNonInteraction.inputDelayMs, null);
  assert.equal(onlyNonInteraction.handlerMs, null);
  assert.equal(onlyNonInteraction.presentationMs, null);
  assert.equal(onlyNonInteraction.durationMs, null);

  const click = summarizeInteractionTiming(
    [
      {
        name: "click",
        startTime: 10,
        duration: 120,
        interactionId: 5,
        processingStart: 20,
        processingEnd: 60,
      },
    ],
    true,
  );
  assert.equal(click.interactionEntries, 1);
  assert.equal(click.inputDelayMs, 10);
  assert.equal(click.handlerMs, 40);
  assert.equal(click.presentationMs, 70);
  assert.equal(click.durationMs, 120);
  assert.equal(click.presentationIsEstimate, true);

  const unsupported = summarizeInteractionTiming([], false);
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.inputDelayMs, null);
  assert.equal(
    summarizeLongTasks([{ startTime: 1, duration: 80 }], false).count,
    null,
    "longtask 观察器缺失时不能写成 0 条",
  );
});

test("冒烟矩阵显式缩小样本，正式矩阵强制 warmup 1 + measured 5", () => {
  const smoke = planMatrix({
    scenarios: RENDERER_LAYOUT_COST_SCENARIOS,
    env: { YCODE_RENDERER_LAYOUT_COST_SMOKE: "1" } as NodeJS.ProcessEnv,
  });
  assert.equal(smoke.smoke, true);
  assert.equal(smoke.groupsPlan.timing.samples, 1);
  assert.equal(smoke.groupsPlan.timing.warmups, 0);

  const formal = planMatrix({
    scenarios: RENDERER_LAYOUT_COST_SCENARIOS,
    env: {} as NodeJS.ProcessEnv,
  });
  assert.equal(formal.smoke, false);
  assert.equal(formal.groupsPlan.timing.samples, 5);
  assert.equal(formal.groupsPlan.timing.warmups, 1);
  assert.equal(formal.expected, formal.variants.length * formal.scenarios.length * 2);
});

test("覆盖把缺失的 variant×case×group 记为失败，不静默跳过 surface", () => {
  const plan = planMatrix({
    scenarios: RENDERER_LAYOUT_COST_SCENARIOS.slice(0, 1),
    env: {} as NodeJS.ProcessEnv,
  });
  const empty = buildCoverage(plan, []);
  assert.equal(empty.complete, false);
  assert.equal(empty.missing.length, plan.expected);
  const problems = coverageProblems(plan, empty, []);
  assert.ok(problems.some((problem) => problem.includes("缺少")));

  const partial = buildCoverage(plan, [
    {
      caseId: plan.scenarios[0].id,
      surface: plan.scenarios[0].surface,
      variant: plan.variants[0],
      group: "timing",
      samples: [],
    },
  ]);
  assert.equal(partial.complete, false);
  assert.ok(partial.missing.some((key) => key.includes("counters")));
  assert.ok(partial.missing.some((key) => key.includes(plan.variants[1])));
});

// ---------------------------------------------------------------------------
// 真实浏览器矩阵：缺 Chromium / 缺 baseline 整段 skip，不写成通过。
// ---------------------------------------------------------------------------

test("renderer 布局成本 prechange/current 对照", async (t) => {
  if (!resolveManifestPath()) {
    t.skip("未设置 YCODE_RENDERER_LAYOUT_COST_BASELINE，整段浏览器对照跳过");
    return;
  }
  const snapshot = await loadPrechangeSnapshot();
  if ("skipped" in snapshot) {
    t.skip(`${snapshot.skipped}；整段浏览器对照跳过`);
    return;
  }
  if (!(await loadChromium())) {
    t.skip("未找到独立 Chromium，整段浏览器对照跳过（不下载、不连接运行中的应用）");
    return;
  }

  const env = process.env;
  const plan = planMatrix({ scenarios: RENDERER_LAYOUT_COST_SCENARIOS, env });
  const result = await runRendererLayoutCostMatrix({ env });
  const summary = summarizeRendererLayoutCost(result);
  const summaryPath = join(result.meta.outDir, "renderer-layout-cost-summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  const acceptance = validateRendererLayoutCost(result, plan);

  t.diagnostic(`结果产物: ${join(result.meta.outDir, "renderer-layout-cost-result.json")}`);
  t.diagnostic(`汇总产物: ${summaryPath}`);
  t.diagnostic(
    `覆盖: expected=${result.meta.coverage.expected} executed=${result.meta.coverage.executed} ` +
      `missing=${result.meta.coverage.missing.length}`,
  );
  t.diagnostic(
    `源码绑定: HEAD=${result.meta.fingerprintBefore.gitHead.slice(0, 12)} ` +
      `dirty=${result.meta.fingerprintBefore.dirtyEntries} frozen=${result.meta.frozen}`,
  );
  t.diagnostic(`fixture 能力: ${result.meta.fixtureCapabilities.join(", ") || "（无）"}`);
  for (const note of acceptance.notes) t.diagnostic(`note: ${note}`);
  if (acceptance.restore) {
    t.diagnostic(
      `restore 偏移: baseline=${acceptance.restore.prechangeOffsetDeltaPx} ` +
        `current=${acceptance.restore.currentOffsetDeltaPx}`,
    );
  }
  if (plan.smoke) {
    t.diagnostic("冒烟运行：不产出性能收益或“已解决卡顿”的结论；正式口径为 warmup 1 + measured 5");
  }

  assert.deepEqual(acceptance.problems, [], acceptance.problems.join("\n"));
  assert.ok(result.results.length > 0, "没有任何用例被执行");
  assert.equal(result.meta.frozen, true, "结果落盘期间的源码指纹发生变化，不能绑定到同一份代码");
  assert.equal(result.meta.coverage.complete, true, "请求的矩阵没有全部执行");
  assert.ok(result.meta.samples >= (plan.smoke ? 1 : 5));
  assert.equal(result.meta.warmups, plan.smoke ? 0 : 1);
});
