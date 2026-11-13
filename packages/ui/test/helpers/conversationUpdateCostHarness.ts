/** 会话更新成本对照的变体编排与结果汇总。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright-core";

import { loadChromium } from "./chromiumFixture.js";
import { buildBundle, buildVariantDefinitions } from "./conversationUpdateCostBuild.js";
import { loadBaselineSources, loadCurrentSources } from "./conversationUpdateCostBaseline.js";
import { runSample } from "./conversationUpdateCostSample.js";
import { toTraceSampleSummary } from "./conversationUpdateCostTrace.js";
import type {
  ConversationUpdateCostResult,
  SampleResult,
  TraceSampleSummary,
  VariantDefinition,
  VariantResult,
} from "./conversationUpdateCostTypes.js";

export type {
  BaselineSources,
  ConversationUpdateCostResult,
  CurrentSources,
  DerivedMode,
  DerivedStatsSample,
  RadixKind,
  SampleResult,
  StepMeasurement,
  TimelineKind,
  VariantDefinition,
  VariantResult,
} from "./conversationUpdateCostTypes.js";
export { buildVariantDefinitions } from "./conversationUpdateCostBuild.js";
export { loadBaselineSources, loadCurrentSources } from "./conversationUpdateCostBaseline.js";
export { extractBaselineDerivedSource } from "./conversationUpdateCostBaseline.js";

async function runVariant(params: {
  context: Awaited<
    ReturnType<
      NonNullable<Awaited<ReturnType<typeof loadChromium>>>["chromium"]["launchPersistentContext"]
    >
  >;
  sessionFactory: (page: Page) => Promise<CDPSession>;
  bundlePath: string;
  variant: VariantDefinition;
  samples: number;
  warmups: number;
  tailwindCss: string | null;
  outDir: string;
  trace?: boolean;
  tracePath?: string;
}): Promise<{ samples: SampleResult[]; tailwindCss: string | null }> {
  const samples: SampleResult[] = [];
  let tailwindCss = params.tailwindCss;
  const total = params.warmups + params.samples;
  for (let index = 0; index < total; index += 1) {
    const page = await params.context.newPage();
    await page.setViewportSize({ width: 1200, height: 900 });
    const mode: "warmup" | "measured" = index < params.warmups ? "warmup" : "measured";
    const sampleIndex = mode === "warmup" ? index : index - params.warmups;
    try {
      const session = await params.sessionFactory(page);
      const { sample, tailwindCss: nextCss } = await runSample({
        page,
        session,
        variant: params.variant,
        sampleIndex,
        mode,
        tailwindCss,
        bundlePath: params.bundlePath,
        trace: params.trace,
        tracePath: params.tracePath,
      });
      tailwindCss = nextCss;
      samples.push(sample);
      await session.detach().catch(() => undefined);
    } finally {
      await page.close();
    }
  }
  return { samples, tailwindCss };
}

export async function runConversationUpdateCostMatrix(options?: {
  samples?: number;
  warmups?: number;
  outDir?: string;
  trace?: boolean;
}): Promise<ConversationUpdateCostResult> {
  const startedAt = Date.now();
  const samplesPerVariant = Math.max(
    1,
    options?.samples ?? Number(process.env.YCODE_UPDATE_COST_SAMPLES ?? 3),
  );
  const warmups = Math.max(
    0,
    options?.warmups ?? Number(process.env.YCODE_UPDATE_COST_WARMUPS ?? 1),
  );
  const outDir =
    options?.outDir ??
    process.env.YCODE_UPDATE_COST_OUT ??
    join(process.env.TEMP ?? process.env.TMP ?? ".", `ycode-update-cost-${startedAt}`);
  await mkdir(outDir, { recursive: true });

  const loadedChromium = await loadChromium();
  if (!loadedChromium) {
    throw Object.assign(new Error("未找到独立 Chromium"), { skipped: true });
  }
  const { chromium, executablePath } = loadedChromium;
  const baseline = await loadBaselineSources();
  if (!baseline.sources) {
    // 直接调用导出函数时也必须显式跳过，不能把当前构建当作 baseline 继续跑。
    throw Object.assign(
      new Error(
        "未找到基线副本；请把 YCODE_UPDATE_COST_BASELINE 指向包含 manifest.json 的临时基线目录",
      ),
      { skipped: true },
    );
  }
  const current = await loadCurrentSources();

  const gaps: string[] = [];
  const baselineHashes = baseline.sources?.hashes ?? {};
  const currentHashes = {
    "repo/packages/ui/src/v4/ConversationTimeline.tsx": current.timelineHash,
    "repo/packages/ui/src/v4/SessionPane.tsx": current.sessionPaneHash,
    "repo/packages/ui/src/v4/pendingGuideProjection.ts": current.pendingGuideProjectionHash,
    "repo/packages/ui/src/v4/sessionPaneDerivedInputs.ts": current.sessionPaneDerivedInputsHash,
    "node_modules/@radix-ui/react-select@2.2.6/dist/index.mjs": current.radixSelectHash,
    "node_modules/@radix-ui/react-scroll-area@1.2.10/dist/index.mjs": current.radixScrollAreaHash,
  };
  const timelineFixed =
    Boolean(baselineHashes["repo/packages/ui/src/v4/ConversationTimeline.tsx"]) &&
    baselineHashes["repo/packages/ui/src/v4/ConversationTimeline.tsx"] !== current.timelineHash;
  const radixFixed =
    Boolean(baselineHashes["node_modules/@radix-ui/react-select@2.2.6/dist/index.mjs"]) &&
    (baselineHashes["node_modules/@radix-ui/react-select@2.2.6/dist/index.mjs"] !==
      current.radixSelectHash ||
      baselineHashes["node_modules/@radix-ui/react-scroll-area@1.2.10/dist/index.mjs"] !==
        current.radixScrollAreaHash);
  if (!timelineFixed)
    gaps.push(
      "当前 Timeline 与 baseline 哈希相同：Timeline 修复未落地，timeline-only 与 combined 不可区分",
    );
  if (!radixFixed)
    gaps.push("当前 Radix 与 baseline 哈希相同：Radix 修复未落地，radix-only 不可区分");
  gaps.push(
    "SessionPane 未整体挂载；derived 分支由基线 SessionPane AST 表达式与旧 pending 模块对照当前真实派生 hook，只覆盖派生输入与 Timeline 交互链路",
  );
  gaps.push(
    "fixture 每次 render 都重建 knownSessionIdSources 并调用 buildKnownSessionIdSet，比真实 SessionPane 的依赖数组更激进；只验证稳定 hook 对等值重建的复用，不声称生产每帧都会重建 Set",
  );
  gaps.push(
    "滚动恢复在虚拟列表测高后存在 baseline 同源的 turn 前进 drift；测试只断言修复后不劣于 baseline，不把 drift 断言为正确语义",
  );
  gaps.push(
    "File tab chrome 与 shell 保活只验证真实 class/hook 投影，不包含真实 Files 工作台的数据与编辑器",
  );
  gaps.push(
    "低开销矩阵不含调用栈采样与 rAF 逐帧轨迹；stepTotal 仍含 Playwright 往返与固定 settle，只作窗口边界，产品延迟以 EventTiming 分栏报告",
  );
  gaps.push(
    "trace 组是单样本、仅 devtools.timeline 类别，与低开销组并排展示采集开销，不做加总或百分比外推；trace 指标在存在 thread_name 元数据时只统计 CrRendererMain，多主线程或缺少元数据时按 pooled 标注",
  );
  gaps.push(
    "fixture 将基线与当前构建的 conversationTimelineDebug 模块都替换为 no-op；对照只覆盖几何读取、DOM 写入与派生引用，不含真实 logger/timer 成本",
  );

  const only = process.env.YCODE_UPDATE_COST_ONLY?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const definitions = buildVariantDefinitions().filter(
    (definition) => !only || only.length === 0 || only.includes(definition.id),
  );
  const builds = new Map<string, BuildArtifacts>();
  const buildByVariant = new Map<string, BuildArtifacts>();
  const variants: VariantResult[] = [];
  let tailwindCss: string | null = null;

  for (const definition of definitions) {
    const timelineKind =
      definition.timeline === "baseline" && baseline.sources ? "baseline" : "current";
    const radixKind = definition.radix === "baseline" && baseline.sources ? "baseline" : "current";
    const derivedKind =
      definition.derived === "baseline" && baseline.sources ? "baseline" : "current";
    const buildKey = `${timelineKind}|${radixKind}|${derivedKind}`;
    const degenerate =
      (definition.timeline === "baseline" && timelineKind === "current") ||
      (definition.radix === "baseline" && radixKind === "current") ||
      (definition.derived === "baseline" && derivedKind === "current") ||
      (definition.timeline === "current" && timelineKind === "baseline") ||
      (definition.radix === "current" && radixKind === "baseline") ||
      (definition.derived === "current" && derivedKind === "baseline");
    if (!builds.has(buildKey)) {
      const timelinePath =
        timelineKind === "baseline" && baseline.sources
          ? baseline.sources.timeline
          : current.timeline;
      builds.set(
        buildKey,
        await buildBundle({
          directory: outDir,
          key: buildKey.replaceAll("|", "-"),
          timelinePath,
          radixBaseline: radixKind === "baseline",
          derived: derivedKind,
          baseline: baseline.sources,
        }),
      );
    }
    const buildArtifact = builds.get(buildKey);
    if (!buildArtifact) throw new Error(`构建缺失: ${buildKey}`);
    buildByVariant.set(definition.id, buildArtifact);

    const context = await chromium.launchPersistentContext(
      join(outDir, `profile-${definition.id}-${buildKey.replaceAll("|", "-")}`),
      {
        executablePath,
        headless: true,
        viewport: { width: 1200, height: 900 },
      },
    );
    try {
      const sessionFactory = async (page: Page): Promise<CDPSession> => {
        const session = await context.newCDPSession(page);
        await session.send("Performance.enable");
        return session;
      };
      const run = await runVariant({
        context,
        sessionFactory,
        bundlePath: buildArtifact.bundlePath,
        variant: definition,
        samples: samplesPerVariant,
        warmups,
        tailwindCss,
        outDir,
      });
      tailwindCss = run.tailwindCss;
      variants.push({
        definition,
        buildKey,
        buildMs: buildArtifact.buildMs,
        degenerate,
        note: definition.note,
        samples: run.samples,
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  // 可选的独立 trace 组：baseline 与 combined 各一个单样本，复用已有 build。
  // 同一六步交互，只额外启用隔离 profile 的 devtools.timeline；与低开销矩阵
  // 并排统计，不并入矩阵样本数，也不重复五变体矩阵。
  const traceEnabled = options?.trace ?? process.env.YCODE_UPDATE_COST_TRACE === "1";
  const traces: TraceSampleSummary[] = [];
  const medianOf = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  if (traceEnabled && definitions.length > 0) {
    const traceDefinitions = definitions.filter(
      (item) => item.id === "baseline" || item.id === "combined",
    );
    if (traceDefinitions.length === 0) traceDefinitions.push(definitions[definitions.length - 1]);
    for (const definition of traceDefinitions) {
      const buildArtifact = buildByVariant.get(definition.id);
      if (!buildArtifact) continue;
      const context = await chromium.launchPersistentContext(
        join(outDir, `profile-trace-${definition.id}`),
        {
          executablePath,
          headless: true,
          viewport: { width: 1200, height: 900 },
        },
      );
      try {
        const sessionFactory = async (page: Page): Promise<CDPSession> => {
          const session = await context.newCDPSession(page);
          await session.send("Performance.enable");
          return session;
        };
        const page = await context.newPage();
        await page.setViewportSize({ width: 1200, height: 900 });
        try {
          const session = await sessionFactory(page);
          const run = await runSample({
            page,
            session,
            variant: definition,
            sampleIndex: 0,
            mode: "measured",
            tailwindCss,
            bundlePath: buildArtifact.bundlePath,
            trace: true,
            tracePath: join(outDir, `trace-${definition.id}.json`),
          });
          tailwindCss = run.tailwindCss;
          if (run.sample.trace) {
            const traceStepMedian = medianOf(run.sample.steps.map((step) => step.stepTotalMs));
            const traceAutomationMedian = medianOf(
              run.sample.steps.map((step) => step.clickRoundTripMs),
            );
            const lowOverheadSteps = variants
              .find((variant) => variant.definition.id === definition.id)
              ?.samples.filter((sample) => sample.mode === "measured")
              .flatMap((sample) => sample.steps);
            const observerLongTasks = run.sample.longTasks;
            traces.push(
              toTraceSampleSummary({
                trace: {
                  ...run.sample.trace,
                  longTask: {
                    count: observerLongTasks.length,
                    totalMs: observerLongTasks.reduce((sum, entry) => sum + entry.duration, 0),
                    source: "trace 样本内 PerformanceObserver longtask",
                  },
                },
                variantId: definition.id,
                sampleIndex: 0,
                traceStepMedianMs: traceStepMedian,
                lowOverheadStepMedianMs: lowOverheadSteps
                  ? medianOf(lowOverheadSteps.map((step) => step.stepTotalMs))
                  : null,
                traceAutomationMedianMs: traceAutomationMedian,
                lowOverheadAutomationMedianMs: lowOverheadSteps
                  ? medianOf(lowOverheadSteps.map((step) => step.clickRoundTripMs))
                  : null,
              }),
            );
          }
          await session.detach().catch(() => undefined);
        } finally {
          await page.close();
        }
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  }

  const result: ConversationUpdateCostResult = {
    meta: {
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      outDir,
      samplesPerVariant,
      warmupPerVariant: warmups,
      updateIntervalMs: 40,
      viewport: { width: 1200, height: 900 },
      baselineManifestPath: baseline.manifestPath,
      baselineAvailable: Boolean(baseline.sources),
      baselineHashes,
      currentHashes,
    },
    variants,
    gaps,
    traces: traces.length > 0 ? traces : undefined,
  };
  await writeFile(
    join(outDir, "conversation-update-cost-result.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
