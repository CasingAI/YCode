/**
 * 覆盖矩阵：请求的 variant × case × group 必须全部执行。
 *
 * 不再用 `availableSurfaces` 静默剔除某个 surface，也不把构建失败/缺 hook 当作跳过；
 * 缺一组就进入 `missing`，验收失败。`ONLY` / `SURFACES` 过滤只允许用于冒烟。
 */
import type { RendererLayoutCostScenario } from "./rendererLayoutCostScenarios.js";
import type {
  RendererLayoutCostCaseResult,
  RendererLayoutCostCoverage,
  RendererLayoutCostGroup,
  RendererLayoutCostGroupPlan,
  RendererLayoutCostVariant,
} from "./rendererLayoutCostTypes.js";

export function parseRequestedList(value: string | undefined): string[] | null {
  if (!value) return null;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export interface MatrixPlan {
  variants: RendererLayoutCostVariant[];
  scenarios: RendererLayoutCostScenario[];
  groups: RendererLayoutCostGroup[];
  groupsPlan: Record<RendererLayoutCostGroup, RendererLayoutCostGroupPlan>;
  expected: number;
  filtered: boolean;
  smoke: boolean;
}

function sampleCount(raw: string | undefined, fallback: number, minimum: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

export function planMatrix(params: {
  scenarios: RendererLayoutCostScenario[];
  env: NodeJS.ProcessEnv;
}): MatrixPlan {
  const { scenarios, env } = params;
  const smoke = env.YCODE_RENDERER_LAYOUT_COST_SMOKE?.trim() === "1";
  const requestedVariants = (parseRequestedList(env.YCODE_RENDERER_LAYOUT_COST_VARIANTS) ?? [
    "prechange",
    "current",
  ]) as RendererLayoutCostVariant[];
  const requestedCases = parseRequestedList(env.YCODE_RENDERER_LAYOUT_COST_ONLY);
  const requestedSurfaces = parseRequestedList(env.YCODE_RENDERER_LAYOUT_COST_SURFACES);
  const timingSamples = smoke
    ? sampleCount(env.YCODE_RENDERER_LAYOUT_COST_SAMPLES, 1, 1)
    : sampleCount(env.YCODE_RENDERER_LAYOUT_COST_SAMPLES, 5, 5);
  const timingWarmups = smoke
    ? sampleCount(env.YCODE_RENDERER_LAYOUT_COST_WARMUPS, 0, 0)
    : sampleCount(env.YCODE_RENDERER_LAYOUT_COST_WARMUPS, 1, 1);
  const counterSamples = sampleCount(env.YCODE_RENDERER_LAYOUT_COST_COUNTER_SAMPLES, 1, 1);
  const groupsPlan: Record<RendererLayoutCostGroup, RendererLayoutCostGroupPlan> = {
    timing: { samples: timingSamples, warmups: timingWarmups },
    counters: { samples: counterSamples, warmups: 0 },
  };
  const selected = scenarios.filter(
    (scenario) =>
      (!requestedCases || requestedCases.includes(scenario.id)) &&
      (!requestedSurfaces || requestedSurfaces.includes(scenario.surface)),
  );
  const groups: RendererLayoutCostGroup[] = ["timing", "counters"];
  return {
    variants: requestedVariants,
    scenarios: selected,
    groups,
    groupsPlan,
    expected: requestedVariants.length * selected.length * groups.length,
    filtered: Boolean(requestedCases || requestedSurfaces),
    smoke,
  };
}

function timingCounts(results: readonly RendererLayoutCostCaseResult[]): {
  measuredByCase: Record<string, number>;
  warmupsByCase: Record<string, number>;
} {
  const measuredByCase: Record<string, number> = {};
  const warmupsByCase: Record<string, number> = {};
  for (const result of results) {
    if (result.group !== "timing") continue;
    const key = `${result.variant}|${result.caseId}`;
    const measured = result.samples.filter((sample) => sample.mode === "measured").length;
    const warmups = result.samples.filter((sample) => sample.mode === "warmup").length;
    measuredByCase[key] = (measuredByCase[key] ?? 0) + measured;
    warmupsByCase[key] = (warmupsByCase[key] ?? 0) + warmups;
  }
  return { measuredByCase, warmupsByCase };
}

export function buildCoverage(
  plan: MatrixPlan,
  results: readonly RendererLayoutCostCaseResult[],
): RendererLayoutCostCoverage {
  const executed = new Set<string>();
  for (const result of results) {
    executed.add(`${result.variant}|${result.caseId}|${result.group}`);
  }
  const missing: string[] = [];
  for (const variant of plan.variants) {
    for (const scenario of plan.scenarios) {
      for (const group of plan.groups) {
        const key = `${variant}|${scenario.id}|${group}`;
        if (!executed.has(key)) missing.push(key);
      }
    }
  }
  const { measuredByCase } = timingCounts(results);
  return {
    requestedVariants: plan.variants,
    requestedCases: plan.scenarios.map((scenario) => scenario.id),
    groups: plan.groups,
    expected: plan.expected,
    executed: executed.size,
    measuredByCase,
    missing,
    filtered: plan.filtered,
    smoke: plan.smoke,
    complete: missing.length === 0,
  };
}

/** 覆盖与样本数验收；返回问题列表，空数组才是通过。 */
export function coverageProblems(
  plan: MatrixPlan,
  coverage: RendererLayoutCostCoverage,
  results: readonly RendererLayoutCostCaseResult[],
): string[] {
  const problems: string[] = [];
  if (!coverage.complete) {
    problems.push(
      `缺少 ${coverage.missing.length} 个 variant×case×group：${coverage.missing.join(", ")}`,
    );
  }
  if (coverage.executed !== plan.expected) {
    problems.push(`执行组合数 ${coverage.executed} ≠ 请求 ${plan.expected}`);
  }
  if (!plan.smoke && plan.filtered) {
    problems.push("正式矩阵不允许 ONLY/SURFACES 过滤；过滤只用于冒烟");
  }
  const { measuredByCase, warmupsByCase } = timingCounts(results);
  const countersMeasured = new Map<string, number>();
  for (const result of results) {
    if (result.group !== "counters") continue;
    const key = `${result.variant}|${result.caseId}`;
    countersMeasured.set(
      key,
      (countersMeasured.get(key) ?? 0) +
        result.samples.filter((sample) => sample.mode === "measured").length,
    );
  }
  for (const variant of plan.variants) {
    for (const scenario of plan.scenarios) {
      const key = `${variant}|${scenario.id}`;
      const measured = measuredByCase[key] ?? 0;
      const warmups = warmupsByCase[key] ?? 0;
      if (measured !== plan.groupsPlan.timing.samples) {
        problems.push(`${key} timing measured=${measured}，要求 ${plan.groupsPlan.timing.samples}`);
      }
      if (warmups !== plan.groupsPlan.timing.warmups) {
        problems.push(`${key} timing warmup=${warmups}，要求 ${plan.groupsPlan.timing.warmups}`);
      }
      const counters = countersMeasured.get(key) ?? 0;
      if (counters !== plan.groupsPlan.counters.samples) {
        problems.push(
          `${key} counters measured=${counters}，要求 ${plan.groupsPlan.counters.samples}`,
        );
      }
    }
  }
  // 非冒烟时样本口径必须达到预热 1 + 至少 5 次测量。
  if (!plan.smoke) {
    if (plan.groupsPlan.timing.samples < 5) problems.push("正式口径 timing samples < 5");
    if (plan.groupsPlan.timing.warmups < 1) problems.push("正式口径 timing warmups < 1");
  }
  return problems;
}
