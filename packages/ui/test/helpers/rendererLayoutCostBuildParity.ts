/**
 * 构建证据：跨变体模块图 / CSS / 共享树 / 依赖版本的一致性断言。
 *
 * P0-1 的验收不是「看起来只换了几个文件」，而是可复算的模块图证据：
 * - 非白名单输入必须全部来自当前 `packages/ui/src` 共享树；
 * - prechange 只允许在白名单模块上读到快照路径；
 * - 两个变体的 CSS 哈希、共享树哈希、依赖版本、归一化后的模块图必须一致。
 *
 * 断言结果随每次构建写入 `layout-cost-build-report.json`，并挂到 return 的 bundle 上，
 * 让报告层可以脱离进程重新核对。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { uiRoot } from "./chromiumFixture.js";
import type { BuiltBundle } from "./rendererLayoutCostBuild.js";
import type { RendererLayoutCostSurface } from "./rendererLayoutCostTypes.js";

const buildRegistry = new Map<string, BuiltBundle>();

function posix(value: string): string {
  return value.split("\\").join("/");
}

function isGeneratedInput(path: string): boolean {
  // 每个变体/表面各有自己的入口与 CSS 模块文件；它们不是产品模块。
  return /(?:entry-[^/]+\.tsx|layout-cost-product-css\.ts)$/.test(path);
}

/** 生成文件按「对应的产品模块」归一，便于跨变体比较模块图。 */
function normalizeInput(build: BuiltBundle, input: string): string {
  let path = posix(input);
  for (const module of build.replacedModules) {
    if (module.snapshotPath && path === posix(module.snapshotPath)) {
      path = posix(module.currentPath);
    }
  }
  if (path.endsWith("prechange-hook/useSidePaneTabsOverflow.ts")) {
    path = posix(join(uiRoot, "src/app-shell/useSidePaneTabsOverflow.ts"));
  }
  if (isGeneratedInput(path)) return "<entry>";
  return path;
}

/**
 * 跨变体差异：除白名单外，模块图、CSS、共享树与依赖版本必须一致。
 * 供 harness / 报告层在两次构建后直接调用；Build 也会自动调用并把结果写进报告文件。
 */
export function assertLayoutCostVariantParity(builds: readonly BuiltBundle[]): string[] {
  const problems: string[] = [];
  const bySurface = new Map<RendererLayoutCostSurface, BuiltBundle[]>();
  for (const build of builds) {
    const list = bySurface.get(build.surface) ?? [];
    list.push(build);
    bySurface.set(build.surface, list);
  }
  for (const [surface, list] of bySurface) {
    const prechange = list.find((build) => build.variant === "prechange");
    const current = list.find((build) => build.variant === "current");
    if (!prechange || !current) {
      problems.push(`${surface}: 缺少一个变体，无法做共享树断言`);
      continue;
    }
    if (prechange.cssSha256 !== current.cssSha256) {
      problems.push(`${surface}: 两个变体 CSS 哈希不同`);
    }
    if (prechange.sharedSourceTreeSha256 !== current.sharedSourceTreeSha256) {
      problems.push(`${surface}: 共享树哈希不同`);
    }
    if (
      JSON.stringify(prechange.dependencyVersions) !== JSON.stringify(current.dependencyVersions)
    ) {
      problems.push(`${surface}: 依赖版本不同`);
    }
    const preInputs = new Set(
      prechange.moduleInputs.map((input) => normalizeInput(prechange, input)),
    );
    const curInputs = new Set(current.moduleInputs.map((input) => normalizeInput(current, input)));
    for (const input of preInputs) {
      if (!curInputs.has(input)) problems.push(`${surface}: prechange 独有输入 ${input}`);
    }
    for (const input of curInputs) {
      if (!preInputs.has(input)) problems.push(`${surface}: current 独有输入 ${input}`);
    }
  }
  return problems;
}

/**
 * 记录一次构建并刷新 outDir 内的构建报告。
 *
 * 同一 outDir 内两个变体都到齐后，`parityProblems` 会被清空或给出具体差异；
 * 报告文件包含模块图、哈希与白名单替换明细，便于事后复核。
 */
export async function recordLayoutCostBuild(outDir: string, build: BuiltBundle): Promise<void> {
  buildRegistry.set(`${outDir}|${build.surface}|${build.variant}`, build);
  const builds = [...buildRegistry.entries()]
    .filter(([key]) => key.startsWith(`${outDir}|`))
    .map(([, value]) => value);
  const parityProblems = assertLayoutCostVariantParity(builds);
  for (const item of builds) item.parityProblems = parityProblems;
  await writeFile(
    join(outDir, "layout-cost-build-report.json"),
    JSON.stringify(
      {
        outDir,
        builds: builds.map((item) => ({
          variant: item.variant,
          surface: item.surface,
          bundleSha256: item.bundleSha256,
          buildMs: item.buildMs,
          cssSha256: item.cssSha256,
          cssBytes: item.cssBytes,
          cssCandidates: item.cssCandidates,
          sharedSourceTreeSha256: item.sharedSourceTreeSha256,
          sourceTreeSha256: item.sourceTreeSha256,
          dependencyVersions: item.dependencyVersions,
          replacedModules: item.replacedModules,
          snapshotContentUsed: item.snapshotContentUsed,
          inputProblems: item.inputProblems,
          moduleInputs: item.moduleInputs,
        })),
        parityProblems,
        computedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
