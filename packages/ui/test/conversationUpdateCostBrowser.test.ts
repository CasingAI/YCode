import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  loadBaselineSources,
  runConversationUpdateCostMatrix,
  type ConversationUpdateCostResult,
  type SampleResult,
  type VariantResult,
} from "./helpers/conversationUpdateCostHarness.js";
import {
  findManifestHashMismatches,
  REQUIRED_BASELINE_KEYS,
} from "./helpers/conversationUpdateCostBaseline.js";
import {
  buildStatisticalNote,
  cdpSecondsToMs,
  restoreTurnShift,
  summarizeConversationUpdateCost,
} from "./helpers/conversationUpdateCostSummary.js";
import { summarizeTraceEvents } from "./helpers/conversationUpdateCostTrace.js";

// 会话更新成本的独立生产态对照（docs/specs/conversation-update-cost.md）。
//
// 只启动本测试自己的 Chromium、临时 profile 与本地 fixture；真实挂载
// ConversationTimeline / ConversationProjectionStore，shell 保活 class 与 File tab
// chrome 直接复用产品实现，Radix 使用 node_modules 里的真实包。before/after 全部由
// 构建期 alias 指向 baseline 副本，不修改、不重置当前工作区。
//
// 时间只报告实测分布，不设“必须小于 N ms”的阈值；稳定断言集中在几何读取、固定
// CSS setter、已完成 turn/未变时间线的重渲染与滚动语义。

function measured(variant: VariantResult): SampleResult[] {
  return variant.samples.filter((sample) => sample.mode === "measured");
}

function finiteNumbers(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value) && value >= 0);
}

// ---------------------------------------------------------------------------
// 轻量纯测试：只验证聚合层，不启动浏览器。
// ---------------------------------------------------------------------------

test("summary 的样本说明依据 meta 与实际样本动态生成", () => {
  const paired = buildStatisticalNote({ warmupPerVariant: 0, samplesPerVariant: 1 }, [
    { samples: [{ mode: "measured" }] },
  ] as unknown as Parameters<typeof buildStatisticalNote>[1]);
  assert.match(paired, /0 次预热 \+ 1 次 measured/);
  assert.doesNotMatch(paired, /1 次预热 \+ 3 次 measured/);

  const matrix = buildStatisticalNote({ warmupPerVariant: 1, samplesPerVariant: 3 }, [
    {
      samples: [
        { mode: "warmup" },
        { mode: "measured" },
        { mode: "measured" },
        { mode: "measured" },
      ],
    },
  ] as unknown as Parameters<typeof buildStatisticalNote>[1]);
  assert.match(matrix, /1 次预热 \+ 3 次 measured/);
});

test("CDP Duration 原始秒值换算为毫秒，且不与其他指标相加", () => {
  assert.ok(Math.abs(cdpSecondsToMs(0.0099) - 9.9) < 1e-9);
  const step = {
    id: "step",
    kind: "session",
    mode: "measured",
    sampleIndex: 0,
    variantId: "baseline",
    clickRoundTripMs: 5,
    waitAfterClickMs: 1,
    stepTotalMs: 20,
    reactCommitMs: 2,
    eventTiming: {
      entries: 1,
      inputDelayMs: 1,
      handlerMs: 2,
      presentationMs: 3,
      durationMs: 6,
    },
    state: {},
    perfDeltas: {
      LayoutCount: 2,
      RecalcStyleCount: 3,
      LayoutDuration: 0.0099,
      RecalcStyleDuration: 0.02,
      TaskDuration: 0.3,
      ScriptDuration: 0.1,
    },
    eventEntries: [],
    longTasks: [],
  };
  const emptyStats = {
    renders: 1,
    knownIdsUnstable: 0,
    pendingGuidesUnstable: 0,
    guideItemChanges: 0,
    knownIdsSize: 5,
    visibleQueueIsCurrent: true,
  };
  const sample = {
    variantId: "baseline",
    sampleIndex: 0,
    mode: "measured",
    derivedMode: "baseline",
    pageErrors: [],
    steps: [step],
    derived: {
      completedTurnRenders: 1,
      runningTurnRenders: 0,
      activeTimelineRenders: 1,
      timelineRenders: 1,
      metadataOnly: emptyStats,
      membership: emptyStats,
      guideSwap: emptyStats,
    },
    prependCommit: {
      timelineScrollTopGets: 1,
      timelineScrollTopSets: 0,
      gbcr: 0,
      styleInnerHtml: 0,
      anyInnerHtml: 0,
    },
    radix: {
      contentOpen: true,
      forcedRerenders: 100,
      styleInnerHtml: 0,
      anyInnerHtml: 0,
      beforeStyleCount: 1,
      afterStyleTextLengths: [1],
    },
    scroll: {
      anchorBefore: null,
      anchorAfter: null,
      anchorStable: null,
      collapseBeforeExpanded: null,
      collapseAfterExpanded: null,
      collapseToggled: null,
      collapseScrollDelta: null,
      restoreTarget: null,
      restoreActual: null,
      restoreDelta: null,
      restoreTargetVisibleTurnId: null,
      restoreActualVisibleTurnId: null,
    },
    events: [],
    longTasks: [],
    syncEntries: [],
  } as unknown as SampleResult;
  const result = {
    meta: {
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
      outDir: ".",
      samplesPerVariant: 1,
      warmupPerVariant: 0,
      updateIntervalMs: 40,
      viewport: { width: 1200, height: 900 },
      baselineManifestPath: "",
      baselineAvailable: false,
      baselineHashes: {},
      currentHashes: {},
    },
    variants: [
      {
        definition: {
          id: "baseline",
          timeline: "baseline",
          radix: "baseline",
          derived: "baseline",
        },
        buildKey: "baseline|baseline|baseline",
        buildMs: 1,
        degenerate: false,
        samples: [sample],
      },
    ],
    gaps: [],
  } as unknown as ConversationUpdateCostResult;
  const row = summarizeConversationUpdateCost(result).variants[0];
  assert.ok(Math.abs(Number(row.browser.layoutDurationMsPerStep) - 9.9) < 1e-9);
  assert.equal(row.browser.recalcStyleDurationMsPerStep, 20);
  assert.equal(row.browser.taskDurationMsPerStep, 300);
  assert.equal(row.browser.scriptDurationMsPerStep, 100);
  assert.match(row.browser.durationUnitNote, /原始单位为秒/);
});

test("基线 manifest 哈希不一致时给出明确不匹配而不是退化", () => {
  const expected = Object.fromEntries(REQUIRED_BASELINE_KEYS.map((key) => [key, "a"]));
  const actual = { ...expected, [REQUIRED_BASELINE_KEYS[0]]: "b" };
  assert.deepEqual(findManifestHashMismatches(expected, expected), []);
  const mismatches = findManifestHashMismatches(expected, actual);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /ConversationTimeline\.tsx/);
  assert.equal(findManifestHashMismatches({}, actual).length, REQUIRED_BASELINE_KEYS.length);
});

test("trace 指标只统计 renderer 主线程，多线程或缺少元数据时标记 pooled", () => {
  const metadata = (pid: number, tid: number, name: string) => ({
    name: "thread_name",
    ph: "M",
    ts: 0,
    pid,
    tid,
    args: { name },
  });
  const parse = (pid: number, tid: number, dur: number) => ({
    name: "ParseHTML",
    ph: "X",
    ts: 0,
    pid,
    tid,
    dur,
  });
  const events = [
    metadata(1, 1, "CrRendererMain"),
    metadata(2, 2, "CrRendererMain"),
    parse(1, 1, 1000),
    parse(2, 2, 2000),
    parse(9, 9, 4000),
  ];
  const pooled = summarizeTraceEvents(events);
  assert.equal(pooled.parseHtml.count, 2);
  assert.equal(pooled.parseHtml.totalMs, 3);
  assert.equal(pooled.threadScope.rendererMainThreadCount, 2);
  assert.equal(pooled.threadScope.pooledAcrossThreads, true);

  const single = summarizeTraceEvents(events.filter((event) => event.pid !== 2 && event.pid !== 9));
  assert.equal(single.parseHtml.totalMs, 1);
  assert.equal(single.threadScope.rendererMainThreadCount, 1);
  assert.equal(single.threadScope.pooledAcrossThreads, false);

  const noMetadata = summarizeTraceEvents(events.filter((event) => event.ph !== "M"));
  assert.equal(noMetadata.parseHtml.count, 3);
  assert.equal(noMetadata.threadScope.rendererMainThreadCount, 0);
  assert.equal(noMetadata.threadScope.pooledAcrossThreads, true);
});

test(
  "独立浏览器对照会话更新成本：baseline/仅Timeline/仅Radix/仅派生/组合",
  { timeout: 900_000 },
  async (t) => {
    // 基线副本是可移植的外部输入；缺失时显式跳过，避免把当前构建伪装成
    // “baseline 对照”后继续产出错误结论。
    const baseline = await loadBaselineSources();
    if (!baseline.sources) {
      t.skip(
        "未找到基线副本；请把 YCODE_UPDATE_COST_BASELINE 指向包含 manifest.json 的临时基线目录",
      );
      return;
    }
    let result: ConversationUpdateCostResult;
    try {
      result = await runConversationUpdateCostMatrix();
    } catch (error) {
      if ((error as { skipped?: boolean }).skipped) {
        t.skip((error as Error).message);
        return;
      }
      throw error;
    }

    const summary = summarizeConversationUpdateCost(result);
    await writeFile(
      join(result.meta.outDir, "conversation-update-cost-summary.json"),
      JSON.stringify({ meta: result.meta, gaps: result.gaps, summary }, null, 2),
    );

    const allSamples = result.variants.flatMap((variant) => variant.samples);
    const measuredSamples = allSamples.filter((sample) => sample.mode === "measured");
    assert.ok(
      result.variants.every((variant) => measured(variant).length >= 1),
      "每个实际运行的变体都要有 measured 样本",
    );

    // 页面必须无异常。
    assert.deepEqual(
      allSamples.flatMap((sample) =>
        sample.pageErrors.map((error) => `${sample.variantId}: ${error}`),
      ),
      [],
      "fixture 页面不应出现 pageerror",
    );

    for (const sample of measuredSamples) {
      const label = `${sample.variantId}#${sample.sampleIndex}`;

      // 六步固定交互：四次 session 选择 + Files + Tasks。
      assert.deepEqual(
        sample.steps.map((step) => step.id),
        [
          "step-1-session-a",
          "step-2-session-b",
          "step-3-session-c",
          "step-4-session-d",
          "step-5-files",
          "step-6-tasks",
        ],
        `${label} 六步顺序必须固定`,
      );
      const byId = new Map(sample.steps.map((step) => [step.id, step]));
      for (const [stepId, sessionId] of [
        ["step-1-session-a", "sess-cost-a"],
        ["step-2-session-b", "sess-cost-b"],
        ["step-3-session-c", "sess-cost-c"],
        ["step-4-session-d", "sess-cost-d"],
      ] as const) {
        const step = byId.get(stepId);
        assert.ok(step, `${label} 缺少 ${stepId}`);
        assert.equal(step.state.activeSessionId, sessionId, `${label} ${stepId} 活动会话`);
        assert.equal(step.state.view, "tasks", `${label} session 步保持 Tasks 视图`);
        assert.ok(
          typeof step.reactCommitMs === "number",
          `${label} ${stepId} 记录同步 React 更新包围耗时`,
        );
      }
      const files = byId.get("step-5-files");
      const tasks = byId.get("step-6-tasks");
      assert.ok(files && tasks, `${label} 缺少 Files/Tasks 步骤`);
      assert.equal(files.state.view, "files");
      assert.equal(tasks.state.view, "tasks");

      // shell 保活 class：Tasks 被移出布局、Files 成为主视图。
      assert.match(
        String(files.state.tasksClass),
        /opacity-0/,
        `${label} Files 视图下 Tasks 保活层透明`,
      );
      assert.match(
        String(files.state.tasksClass),
        /absolute/,
        `${label} Files 视图下 Tasks 保活层绝对定位`,
      );
      assert.doesNotMatch(
        String(files.state.filesClass),
        /opacity-0/,
        `${label} Files 视图自身可见`,
      );
      assert.doesNotMatch(
        String(tasks.state.tasksClass),
        /opacity-0/,
        `${label} Tasks 视图自身可见`,
      );
      assert.match(
        String(tasks.state.filesClass),
        /opacity-0/,
        `${label} Tasks 视图下 Files 保活层透明`,
      );

      // File tab chrome：真实 hook 在 Files 激活时写入，切回 Tasks 时清理。
      const chrome = files.state.filesChrome;
      assert.ok(Array.isArray(chrome) && chrome.length === 2, `${label} 两个真实 tablist`);
      const wide = chrome.find((row) => row.name === "wide");
      const narrow = chrome.find((row) => row.name === "narrow");
      assert.ok(wide && narrow, `${label} wide/narrow tablist 均存在`);
      assert.ok(Number.parseFloat(wide.leadingInset) >= 100, `${label} wide leading inset`);
      assert.ok(Number.parseFloat(wide.trailingInset) >= 80, `${label} wide trailing inset`);
      assert.ok(Number.parseFloat(wide.height) >= 36, `${label} wide 高度`);
      assert.ok(Number.parseFloat(narrow.topInset) >= 32, `${label} narrow 走整行下移分支`);
      assert.ok(Number.parseFloat(narrow.height) >= 64, `${label} narrow 高度包含下移`);
      for (const row of tasks.state.filesChrome) {
        assert.equal(row.leadingInset, "", `${label} Tasks 视图清理 leading inset`);
        assert.equal(row.trailingInset, "", `${label} Tasks 视图清理 trailing inset`);
        assert.equal(row.topInset, "", `${label} Tasks 视图清理 top inset`);
        assert.equal(row.height, "", `${label} Tasks 视图清理 height`);
      }

      // 上翻历史：流式更新不得改变用户视口锚点。
      assert.equal(
        sample.scroll.anchorStable,
        true,
        `${label} 上翻后增量更新保持 scrollTop 与首可见 turn`,
      );
      assert.ok(
        sample.scroll.anchorBefore && sample.scroll.anchorBefore.scrollTop > 0,
        `${label} 上翻锚点应离开顶部`,
      );

      // 折叠：真实 history trigger 的展开态必须翻转。
      assert.equal(
        sample.scroll.collapseToggled,
        true,
        `${label} 折叠展开态翻转: ${JSON.stringify(sample.scroll)}`,
      );
      assert.notEqual(sample.scroll.collapseBeforeExpanded, null, `${label} 存在可折叠历史段`);

      // 会话切换后的滚动恢复由 Timeline 的模块级 scroll memory 完成。
      //
      // 恢复的稳定语义分两段，不能把两者混成一个像素相等断言：
      //   1. 切回会话时先按记忆值写入 scrollTop（几何读取／轨迹里可精确核对）；
      //   2. 虚拟列表重新测高后，Timeline 以前插补偿的方式平移 scrollTop，位移应
      //      恰好等于同段内容高度增量。
      //
      // 已知既有 drift（baseline 也存在）：补偿后首可见 turn 可能比目标前进若干条。
      // 本测试不把“turn 前进”当成正确语义，只在后面的基线对照中断言修复后不劣于
      // baseline；此处只校验写回目标、位移来源与最终停在中段历史。
      assert.notEqual(sample.scroll.restoreTarget, null, `${label} 记录恢复目标`);
      assert.notEqual(sample.scroll.restoreDelta, null, `${label} 记录恢复结果`);
      const restoreTarget = Number(sample.scroll.restoreTarget);
      const restoreTrace = sample.scroll.restoreTrace ?? [];
      const returnClick = restoreTrace.find((entry) => entry.source === "test:click-session-4");
      assert.ok(returnClick, `${label} 记录切回会话的轨迹标记`);
      const afterReturn = returnClick
        ? restoreTrace.filter((entry) => entry.t >= returnClick.t)
        : [];
      const restoreWrite = afterReturn.find((entry) => Math.abs(entry.top - restoreTarget) <= 1);
      assert.ok(
        restoreWrite,
        `${label} 切回会话应先写回记忆 scrollTop=${restoreTarget}: ${JSON.stringify(
          afterReturn.slice(0, 6),
        )}`,
      );
      const settled =
        afterReturn.find((entry) => entry.source === "test:settled") ??
        afterReturn[afterReturn.length - 1];
      assert.ok(settled, `${label} 记录恢复后的最终几何`);
      const measurementGrowth = settled.scrollHeight - restoreWrite.scrollHeight;
      const scrollShift = settled.top - restoreWrite.top;
      assert.equal(
        scrollShift,
        measurementGrowth,
        `${label} 恢复后的位移只应来自虚拟列表测高补偿: shift=${scrollShift} growth=${measurementGrowth} target=${restoreTarget} actual=${sample.scroll.restoreActual}`,
      );
      assert.ok(
        settled.top > 0 && settled.top < settled.scrollHeight - settled.clientHeight,
        `${label} 恢复后应停在中段历史，而非顶部或底部: ${JSON.stringify(settled)}`,
      );
      assert.ok(restoreWrite.turn, `${label} 恢复写入点有可见 turn`);
      assert.ok(settled.turn, `${label} 恢复完成后有可见 turn`);
      const memoryAtActual = sample.scroll.restoreMemory?.atActual as
        | Record<string, { scrollTop?: number } | undefined>
        | undefined;
      const rememberedState =
        restoreWrite.activeSession && memoryAtActual
          ? memoryAtActual[restoreWrite.activeSession]
          : undefined;
      assert.ok(
        rememberedState && Math.abs(Number(rememberedState.scrollTop) - restoreTarget) <= 1,
        `${label} 离开会话时保存的滚动记忆等于目标值`,
      );

      // 时间指标必须真实可读，不能用缺失值冒充通过。
      assert.ok(
        finiteNumbers(sample.steps.map((step) => step.stepTotalMs)),
        `${label} step 时长有限`,
      );
      assert.ok(
        finiteNumbers(sample.steps.map((step) => step.clickRoundTripMs)),
        `${label} 点击往返有限`,
      );

      // EventTiming 只做存在性与非负校验；没有超过 16ms 的条目时保持 null，
      // 不用固定 settle 伪造事件处理延迟。
      for (const step of sample.steps) {
        const timing = step.eventTiming;
        for (const [name, value] of [
          ["inputDelay", timing.inputDelayMs],
          ["handler", timing.handlerMs],
          ["presentation", timing.presentationMs],
          ["duration", timing.durationMs],
        ] as const) {
          if (value !== null) {
            assert.ok(
              Number.isFinite(value) && value >= 0,
              `${label} ${step.id} EventTiming ${name} 非负: ${value}`,
            );
          }
        }
      }

      // 派生引用：当前真实入口在等价输入下复用引用；基线 SessionPane AST/旧 pending
      // 投影在同一受控输入下应持续重建。guide item 真正替换时，两种实现都必须更新。
      const derivedStats = sample.derived;
      assert.ok(derivedStats.metadataOnly.renders > 0, `${label} 记录元数据更新阶段的派生渲染`);
      assert.equal(
        derivedStats.metadataOnly.visibleQueueIsCurrent,
        true,
        `${label} visibleQueue 必须来自当前 queue`,
      );
      if (sample.derivedMode === "current") {
        assert.equal(
          derivedStats.completedTurnRenders,
          0,
          `${label} 当前派生下已完成 turn 零重渲染`,
        );
        assert.equal(
          derivedStats.activeTimelineRenders,
          0,
          `${label} 当前派生下活动 Timeline 零重渲染`,
        );
        assert.equal(
          derivedStats.metadataOnly.knownIdsUnstable,
          0,
          `${label} 成员不变的元数据更新不得重建 knownSessionIds`,
        );
        assert.equal(
          derivedStats.metadataOnly.pendingGuidesUnstable,
          0,
          `${label} guide item 引用不变时不得重建 pendingGuides`,
        );
        assert.equal(
          derivedStats.membership.knownIdsSize,
          5,
          `${label} 成员新增进入 knownSessionIds`,
        );
        assert.ok(
          derivedStats.membership.knownIdsUnstable >= 1,
          `${label} knownSessionIds 成员变化必须换新 Set`,
        );
        assert.equal(
          derivedStats.guideSwap.guideItemChanges,
          1,
          `${label} guide item 替换只应被计为一次变化`,
        );
        assert.ok(
          derivedStats.guideSwap.pendingGuidesUnstable >= 1,
          `${label} guide item 真正替换时必须重建 pendingGuides`,
        );
      } else {
        assert.ok(
          derivedStats.completedTurnRenders > 0,
          `${label} 基线派生下已完成 turn 应重渲染（得到 ${derivedStats.completedTurnRenders}）`,
        );
        assert.ok(
          derivedStats.activeTimelineRenders > 0,
          `${label} 基线派生下活动 Timeline 应重渲染`,
        );
        assert.ok(
          derivedStats.metadataOnly.knownIdsUnstable > 0,
          `${label} 基线 SessionPane 派生在成员等价输入下仍每帧重建 Set`,
        );
        assert.ok(
          derivedStats.metadataOnly.pendingGuidesUnstable > 0,
          `${label} 旧 pending 投影在 item 引用不变时仍每帧重建数组`,
        );
        assert.ok(
          derivedStats.guideSwap.guideItemChanges >= 1,
          `${label} 基线派生也必须在 guide item 替换时更新`,
        );
      }
    }

    if (result.meta.baselineAvailable) {
      const variantOf = (sample: SampleResult) =>
        result.variants.find((variant) => variant.definition.id === sample.variantId);
      const baselineTimelineSamples = measuredSamples.filter(
        (sample) => variantOf(sample)?.definition.timeline === "baseline",
      );
      const fixedTimelineSamples = measuredSamples.filter(
        (sample) => variantOf(sample)?.definition.timeline === "current",
      );
      const baselineRadixSamples = measuredSamples.filter(
        (sample) => variantOf(sample)?.definition.radix === "baseline",
      );
      const fixedRadixSamples = measuredSamples.filter(
        (sample) => variantOf(sample)?.definition.radix === "current",
      );

      // 该窗口只推送活动会话的流式行，没有前插。baseline 的 prepend effect 仍为诊断
      // 读取 scrollTop（外加 content-anchor reconcile 的一次业务读取）；修复后只剩
      // 业务读取。真实 no-prepend effect 测试有严格的 0 诊断读取断言；这里组合场景
      // 只要求修复后不劣于 baseline 最好样本，不把业务读取次数钉死为 1。
      if (baselineTimelineSamples.length > 0) {
        assert.ok(
          baselineTimelineSamples.every((sample) => sample.prependCommit.timelineScrollTopGets > 1),
          `baseline Timeline 无前插提交仍含诊断 scrollTop 读取: ${baselineTimelineSamples
            .map((sample) => sample.prependCommit.timelineScrollTopGets)
            .join(",")}`,
        );
      }
      if (baselineTimelineSamples.length > 0 && fixedTimelineSamples.length > 0) {
        // 不把修复后固定为 1：这里只要求相对 baseline 明确减少或至少不劣。
        // no-prepend 真实 effect 测试已有严格的 0 断言，组合场景不必钉死业务读取次数。
        const baselineGets = baselineTimelineSamples.map(
          (sample) => sample.prependCommit.timelineScrollTopGets,
        );
        const minBaselineGets = Math.min(...baselineGets);
        for (const sample of fixedTimelineSamples) {
          assert.ok(
            sample.prependCommit.timelineScrollTopGets <= minBaselineGets,
            `修复后 Timeline 几何读取不得劣于 baseline 最好样本: ${sample.variantId}=` +
              `${sample.prependCommit.timelineScrollTopGets} baselineMin=${minBaselineGets}`,
          );
        }
      }

      // Radix 固定 CSS：修复前强制重渲染写入 style.innerHTML，修复后 0。
      if (baselineRadixSamples.length > 0) {
        assert.ok(
          baselineRadixSamples.every((sample) => sample.radix.styleInnerHtml > 0),
          `baseline Radix 强制重渲染应写 style.innerHTML: ${baselineRadixSamples
            .map((sample) => sample.radix.styleInnerHtml)
            .join(",")}`,
        );
      }
      if (fixedRadixSamples.length > 0) {
        assert.ok(
          fixedRadixSamples.every((sample) => sample.radix.styleInnerHtml === 0),
          `修复后 Radix 强制重渲染不得写 style.innerHTML: ${fixedRadixSamples
            .map((sample) => `${sample.variantId}=${sample.radix.styleInnerHtml}`)
            .join(",")}`,
        );
      }

      // 已知 restore drift：baseline 也会在虚拟列表测高后让首可见 turn 前进。
      // 不把该现象断言为“正确”，只要求修复后像素偏移与 turn 漂移不劣于 baseline。
      const baselineTurnShifts = baselineTimelineSamples
        .map((sample) => restoreTurnShift(sample))
        .filter((value): value is number => value !== null);
      const baselinePixelDeltas = baselineTimelineSamples
        .map((sample) => Math.abs(Number(sample.scroll.restoreDelta)))
        .filter((value) => Number.isFinite(value));
      if (baselineTurnShifts.length > 0 && fixedTimelineSamples.length > 0) {
        const maxBaselineTurnShift = Math.max(...baselineTurnShifts);
        for (const sample of fixedTimelineSamples) {
          const shift = restoreTurnShift(sample);
          assert.ok(
            shift === null || shift <= maxBaselineTurnShift,
            `修复后恢复 turn 漂移不得劣于 baseline: ${sample.variantId} shift=${shift} ` +
              `baselineMax=${maxBaselineTurnShift}`,
          );
        }
      }
      if (baselinePixelDeltas.length > 0 && fixedTimelineSamples.length > 0) {
        const maxBaselinePixelDelta = Math.max(...baselinePixelDeltas);
        for (const sample of fixedTimelineSamples) {
          const delta = Math.abs(Number(sample.scroll.restoreDelta));
          // 不添加任意像素容差：同源基线给出上界，修复后的偏移必须不超过它。
          assert.ok(
            Number.isFinite(delta) && delta <= maxBaselinePixelDelta,
            `修复后恢复像素偏移不得劣于 baseline: ${sample.variantId} delta=${delta} ` +
              `baselineMax=${maxBaselinePixelDelta}`,
          );
        }
      }
    }

    // 可选 trace 组：baseline/combined 各单样本，只做采集完整性与落盘位置校验，
    // 不与矩阵指标相加。Windows 的 join 产生反斜杠，比较前只统一分隔符。
    if (result.traces && result.traces.length > 0) {
      const normalize = (value: string) => value.replaceAll("\\", "/");
      for (const trace of result.traces) {
        assert.ok(
          trace.variantId === "baseline" || trace.variantId === "combined",
          `trace 组只覆盖 baseline/combined: ${trace.variantId}`,
        );
        assert.deepEqual(
          trace.categories,
          ["devtools.timeline"],
          "trace 只启用 devtools.timeline 必要类别",
        );
        assert.ok(
          normalize(trace.outputPath).startsWith(normalize(result.meta.outDir)),
          `trace 必须写到本次 OS 临时输出目录: ${trace.outputPath}`,
        );
        assert.ok(trace.eventCount > 0, "trace 采集到事件");
        for (const [name, metrics] of [
          ["ParseHTML", trace.parseHtml],
          ["UpdateLayoutTree", trace.updateLayoutTree],
          ["Layout", trace.layout],
          ["Paint", trace.paint],
        ] as const) {
          assert.ok(
            Number.isFinite(metrics.totalMs) &&
              metrics.totalMs >= 0 &&
              metrics.count >= 0 &&
              metrics.maxMs >= 0,
            `trace ${trace.variantId} ${name} 统计非负`,
          );
        }
        assert.ok(
          Number.isFinite(trace.longTask.totalMs) && trace.longTask.count >= 0,
          "trace longTask 统计非负",
        );
      }
    }

    t.diagnostic(`result: ${join(result.meta.outDir, "conversation-update-cost-result.json")}`);
    t.diagnostic(`summary: ${join(result.meta.outDir, "conversation-update-cost-summary.json")}`);
    for (const trace of result.traces ?? []) {
      t.diagnostic(
        `trace ${trace.variantId}: ` +
          `ParseHTML=${trace.parseHtml.count}/${trace.parseHtml.totalMs}ms ` +
          `UpdateLayoutTree=${trace.updateLayoutTree.count}/${trace.updateLayoutTree.totalMs}ms ` +
          `Layout=${trace.layout.count}/${trace.layout.totalMs}ms ` +
          `Paint=${trace.paint.count}/${trace.paint.totalMs}ms ` +
          `longTask=${trace.longTask.count}/${trace.longTask.totalMs}ms ` +
          `path=${trace.outputPath}`,
      );
    }
    for (const row of summary.variants) {
      t.diagnostic(
        `${row.id} (${row.buildKey}, ${row.derivedMode}) n=${row.measuredSamples} ` +
          `automationClick=${row.automation.clickRoundTripMs}ms ` +
          `syncReactUpdateEnvelope=${row.automation.synchronousReactUpdateEnvelopeMs}ms ` +
          `event[duration=${row.eventTiming.durationMs}ms handler=${row.eventTiming.handlerMs}ms ` +
          `available=${row.eventTiming.availableSteps}/${row.eventTiming.totalSteps}] ` +
          `scrollTopGets=${row.static.timelineScrollTopGets.join("/")} ` +
          `radixWrites=${row.static.radixStyleInnerHtml.join("/")} ` +
          `completedRenders=${row.static.completedTurnRenders.join("/")} ` +
          `restoreDelta=${row.knownRestoreDrift.map((entry) => entry.delta).join("/")} ` +
          `restoreTurnShift=${row.knownRestoreDrift.map((entry) => entry.turnShift).join("/")}`,
      );
    }
  },
);
