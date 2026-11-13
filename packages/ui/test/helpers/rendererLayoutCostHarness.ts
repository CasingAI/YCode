/**
 * prechange / current 的浏览器对照编排（几何计数 + 低开销时间两组）。
 *
 * 只启动本测试自己的独立 Chromium 与临时 profile，不连接运行中的 YCode。
 * 正式矩阵：每 case 每组每变体 warmup 1 + measured 5（counters 组固定 1 次）；
 * 冒烟必须显式 `YCODE_RENDERER_LAYOUT_COST_SMOKE=1`，且不产出性能结论。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

import { loadChromium, uiRoot } from "./chromiumFixture.js";
import {
  assertLayoutCostVariantParity,
  buildSurfaceBundle,
  generatePrechangeSidePaneHook,
  type BuiltBundle,
} from "./rendererLayoutCostBuild.js";
import { buildCoverage, planMatrix } from "./rendererLayoutCostCoverage.js";
import {
  collectSourceFingerprint,
  fingerprintMatches,
  fingerprintSourcesMatch,
} from "./rendererLayoutCostMeta.js";
import { runCaseSamples } from "./rendererLayoutCostSampling.js";
import { RENDERER_LAYOUT_COST_SCENARIOS } from "./rendererLayoutCostScenarios.js";
import { loadPrechangeSnapshot, resolveCurrentSource } from "./rendererLayoutCostSnapshot.js";
import type {
  RendererLayoutCostBundleMeta,
  RendererLayoutCostCaseResult,
  RendererLayoutCostResult,
  RendererLayoutCostSurface,
} from "./rendererLayoutCostTypes.js";

export { summarizeRendererLayoutCost } from "./rendererLayoutCostSummary.js";
export { validateRendererLayoutCost } from "./rendererLayoutCostAcceptance.js";
export type { AcceptanceReport } from "./rendererLayoutCostAcceptance.js";

export interface RendererLayoutCostRunOptions {
  outDir?: string;
  env?: NodeJS.ProcessEnv;
}

const REQUIRED_BASE_GAPS = [
  "timing 组不 patch getter；counters 组带 getter monkeypatch，其耗时不得用于时间收益结论",
  "EventTiming 只统计 interactionId>0 的真实交互；观察阈值 16ms，低于阈值的交互不进入样本，entries 缺失为 null 而非 0",
  "presentation 由 duration 减去处理区间得到，是估计残差，不是独立测量",
  "bundle 求值单独记为 bundleEvalMs，不进入场景窗口；窗口不使用固定 settle",
  "产品 CSS 由构建期静态扫描源码生成，并在 bundle 求值时注入，早于任何 mount",
  "两个变体共用当前 packages/ui/src 共享树，prechange 只在 onLoad 替换本批白名单模块",
  "多步场景包含 Playwright 往返与 fixture 版本信号，时间只用于相同 harness 下两变体的相对比较",
  "未复测原完整 YCode 会话；fixture 结果不得外推为原卡顿已解决",
  "toolbar 使用真实 hook + 有界 DOM；sidepane 的 prechange 使用从面板 AST 抽取的 bounded hook",
  "fixture 使用受控历史长度（21 轮）；首绘/前插只覆盖受控窗口，不等于完整会话历史",
  "turnCounts 是 memo wrapper 的 render 次数，不是 React commit 次数",
];

/** 构建期证据汇总：输入图、白名单替换、跨变体 parity 都必须为空问题。 */
function buildProblemsOf(builds: readonly BuiltBundle[]): string[] {
  const problems: string[] = [];
  for (const build of builds) {
    const label = `${build.variant}/${build.surface}`;
    for (const problem of build.inputProblems) problems.push(`${label} 输入图：${problem}`);
    if (build.variant === "prechange" && build.snapshotContentUsed.length === 0) {
      problems.push(`${label} prechange 没有使用任何快照内容`);
    }
    if (build.variant === "current" && build.snapshotContentUsed.length > 0) {
      problems.push(`${label} current 加载了快照内容：${build.snapshotContentUsed.join(", ")}`);
    }
    if (!(build.cssBytes > 0)) problems.push(`${label} 静态产品 CSS 为空`);
  }
  for (const problem of assertLayoutCostVariantParity(builds)) problems.push(`parity：${problem}`);
  return problems;
}

function assertFreshOutDir(outDir: string): void {
  if (outDir.includes("ycode-renderer-layout-cost-1794589041934")) {
    throw new Error(
      "该产物目录是已废弃的旧口径（bundle 污染 initial-fill），不能复用；请使用新的临时目录",
    );
  }
}

export async function runRendererLayoutCostMatrix(
  options?: RendererLayoutCostRunOptions,
): Promise<RendererLayoutCostResult> {
  const startedAt = Date.now();
  const env = options?.env ?? process.env;
  const plan = planMatrix({ scenarios: RENDERER_LAYOUT_COST_SCENARIOS, env });
  if (plan.scenarios.length === 0) {
    throw new Error("过滤条件没有选中任何用例；不能用空矩阵宣称通过");
  }
  const outDir =
    options?.outDir ??
    env.YCODE_RENDERER_LAYOUT_COST_OUT ??
    join(env.TEMP ?? env.TMP ?? ".", `ycode-renderer-layout-cost-${startedAt}`);
  assertFreshOutDir(outDir);
  await mkdir(outDir, { recursive: true });

  const loaded = await loadPrechangeSnapshot();
  if ("skipped" in loaded) {
    throw Object.assign(new Error(loaded.skipped), { skipped: true });
  }
  const snapshot = loaded.snapshot;
  const loadedChromium = await loadChromium();
  if (!loadedChromium) {
    throw Object.assign(new Error("未找到独立 Chromium"), { skipped: true });
  }
  const { chromium, executablePath } = loadedChromium;

  const gaps: string[] = [...REQUIRED_BASE_GAPS];
  if (plan.filtered) gaps.push("本次使用 ONLY/SURFACES 过滤，只报告被选中的子集，不代表全矩阵");
  if (plan.smoke) {
    gaps.push("冒烟运行显式缩小样本；只验证 harness 接线，不产出性能收益结论");
  }

  // 构建前先记一次源码指纹；构建若读到不同版本，整份结果不能绑定到同一份代码。
  const fingerprintAtBuildStart = await collectSourceFingerprint(snapshot, null);
  const prechangeHook = await generatePrechangeSidePaneHook(snapshot.uiModuleRoot, outDir);
  const currentSidePaneHook = await resolveCurrentSource(
    "src/app-shell/useSidePaneTabsOverflow.ts",
  );
  if (!currentSidePaneHook) {
    gaps.push(
      "current 缺少 useSidePaneTabsOverflow.ts；current/sidepane 组合会记为缺失，不当作通过",
    );
  }
  const surfaces = [
    ...new Set(plan.scenarios.map((scenario) => scenario.surface)),
  ] as RendererLayoutCostSurface[];

  const bundles = new Map<string, BuiltBundle>();
  const bundleMetas: RendererLayoutCostBundleMeta[] = [];
  const moduleInputSets = new Set<string>();
  for (const variant of plan.variants) {
    const uiModuleRoot = variant === "prechange" ? snapshot.uiModuleRoot : uiRoot;
    for (const surface of surfaces) {
      const hookPath =
        surface === "sidepane"
          ? variant === "prechange"
            ? prechangeHook
            : (currentSidePaneHook ?? null)
          : null;
      try {
        const build = await buildSurfaceBundle({
          variant,
          surface,
          uiModuleRoot,
          outDir,
          sidePaneHookPath: hookPath,
        });
        bundles.set(`${variant}|${surface}`, build);
        for (const input of build.moduleInputs) moduleInputSets.add(input);
        bundleMetas.push({
          variant,
          surface,
          bundlePath: build.bundlePath,
          bundleSha256: build.bundleSha256,
          buildMs: build.buildMs,
          moduleInputs: build.moduleInputs,
          cssPath: build.cssPath,
          cssSha256: build.cssSha256,
          cssBytes: build.cssBytes,
          cssCandidates: build.cssCandidates,
          sharedSourceTreeSha256: build.sharedSourceTreeSha256,
          sourceTreeSha256: build.sourceTreeSha256,
          replacedModules: build.replacedModules.map((module) => ({
            key: module.key,
            currentSha256: module.currentSha256,
            snapshotSha256: module.snapshotSha256,
            bundled: module.bundled,
          })),
          snapshotContentUsed: [...build.snapshotContentUsed],
          dependencyVersions: build.dependencyVersions,
          inputProblems: [...build.inputProblems],
          parityProblems: [...build.parityProblems],
        });
      } catch (error) {
        gaps.push(`${variant}/${surface} 构建失败，对应组合记为缺失：${(error as Error).message}`);
      }
    }
  }

  const moduleInputs = moduleInputSets.size > 0 ? [...moduleInputSets].sort() : null;
  const buildProblems = [...new Set(buildProblemsOf([...bundles.values()]))];
  // 逐条构建时记下的 parity 只反映当时已完成的变体；落盘前统一用两变体都到齐后的结果覆盖。
  const finalParityProblems = assertLayoutCostVariantParity([...bundles.values()]);
  for (const meta of bundleMetas) meta.parityProblems = [...finalParityProblems];
  for (const problem of buildProblems) gaps.push(problem);
  const fingerprintBefore = await collectSourceFingerprint(snapshot, moduleInputs);
  const sourceStableDuringBuild = fingerprintSourcesMatch(
    fingerprintAtBuildStart,
    fingerprintBefore,
  );
  if (!sourceStableDuringBuild) {
    gaps.push("构建期间源码 / 依赖 / prechange 快照发生变化，结果不能绑定到同一份代码");
  }

  const results: RendererLayoutCostCaseResult[] = [];
  const capabilitySet = new Set<string>();
  for (const variant of plan.variants) {
    const context: BrowserContext = await chromium.launchPersistentContext(
      join(outDir, `profile-${variant}`),
      { executablePath, headless: true, viewport: { width: 1200, height: 900 } },
    );
    const sessionFactory = async (page: Page): Promise<CDPSession> => {
      const session = await context.newCDPSession(page);
      await session.send("Performance.enable");
      return session;
    };
    try {
      for (const surface of surfaces) {
        const build = bundles.get(`${variant}|${surface}`);
        if (!build) continue;
        for (const scenario of plan.scenarios.filter((item) => item.surface === surface)) {
          for (const group of plan.groups) {
            const caseResult = await runCaseSamples({
              context,
              sessionFactory,
              bundle: build,
              scenario,
              group,
              samples: plan.groupsPlan[group].samples,
              warmups: plan.groupsPlan[group].warmups,
            });
            for (const sample of caseResult.samples) {
              for (const capability of sample.fixtureCapabilities) capabilitySet.add(capability);
            }
            results.push(caseResult);
          }
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  const fingerprintAfter = await collectSourceFingerprint(snapshot, moduleInputs);
  const coverage = buildCoverage(plan, results);
  const missingCapabilities = plan.scenarios
    .flatMap((scenario) => scenario.requiredCapabilities)
    .filter((name) => !capabilitySet.has(name));
  if (missingCapabilities.length > 0 && !plan.smoke) {
    gaps.push(`fixture 缺少正式验收能力：${[...new Set(missingCapabilities)].join(", ")}`);
  }
  if (plan.smoke) {
    gaps.push(
      "冒烟样本缺少 fixture 新 API 时仍会落盘，但 timingEligible=false，不得引用为时间结论",
    );
  }

  const result: RendererLayoutCostResult = {
    meta: {
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      outDir,
      runId: `ycode-renderer-layout-cost-${startedAt}`,
      smoke: plan.smoke,
      samples: plan.groupsPlan.timing.samples,
      warmups: plan.groupsPlan.timing.warmups,
      groups: plan.groupsPlan,
      viewport: { width: 1200, height: 900 },
      manifestPath: snapshot.manifestPath,
      manifestSha256: snapshot.manifestSha256,
      prechangeHashes: snapshot.hashes,
      currentHashes: Object.fromEntries(
        Object.entries(fingerprintBefore.sourceHashes).filter(([key]) =>
          key.startsWith("packages/ui/src/"),
        ),
      ),
      cases: plan.scenarios.map((scenario) => scenario.id),
      variants: plan.variants,
      coverage,
      fingerprintBefore,
      fingerprintAfter,
      sourceStableDuringBuild,
      frozen: sourceStableDuringBuild && fingerprintMatches(fingerprintBefore, fingerprintAfter),
      bundles: bundleMetas,
      buildProblems,
      fixtureCapabilities: [...capabilitySet].sort(),
    },
    results,
    gaps,
  };
  await writeFile(
    join(outDir, "renderer-layout-cost-result.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
