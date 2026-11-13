/** 单 case × 单组 × 单变体的采样循环：每次 measured 使用新页面。 */
import type { BrowserContext, CDPSession, Page } from "playwright-core";

import type { BuiltBundle } from "./rendererLayoutCostBuild.js";
import { measureSample } from "./rendererLayoutCostMeasurement.js";
import type { RendererLayoutCostScenario } from "./rendererLayoutCostScenarios.js";
import type {
  RendererLayoutCostCaseResult,
  RendererLayoutCostGroup,
  RendererLayoutCostSample,
} from "./rendererLayoutCostTypes.js";

export interface RunCaseParams {
  context: BrowserContext;
  sessionFactory: (page: Page) => Promise<CDPSession>;
  bundle: BuiltBundle;
  scenario: RendererLayoutCostScenario;
  group: RendererLayoutCostGroup;
  samples: number;
  warmups: number;
}

export async function runCaseSamples(params: RunCaseParams): Promise<RendererLayoutCostCaseResult> {
  const results: RendererLayoutCostSample[] = [];
  const total = params.warmups + params.samples;
  for (let index = 0; index < total; index += 1) {
    const mode: "warmup" | "measured" = index < params.warmups ? "warmup" : "measured";
    const sampleIndex = mode === "warmup" ? index : index - params.warmups;
    const page = await params.context.newPage();
    await page.setViewportSize({ width: 1200, height: 900 });
    try {
      const session = await params.sessionFactory(page);
      try {
        results.push(
          await measureSample({
            page,
            session,
            scenario: params.scenario,
            bundle: params.bundle,
            sampleIndex,
            mode,
            group: params.group,
          }),
        );
      } finally {
        await session.detach().catch(() => undefined);
      }
    } finally {
      await page.close();
    }
  }
  return {
    caseId: params.scenario.id,
    surface: params.scenario.surface,
    variant: params.bundle.variant,
    group: params.group,
    samples: results,
  };
}
