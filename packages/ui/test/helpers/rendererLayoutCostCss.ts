/**
 * 启动前可用的完整产品 CSS（P0-2 修正）。
 *
 * 之前 harness 在页面 ready 之后才从 live DOM 收集类名再编译，staging 处于隐藏态、
 * 且首绘完成后节点已撤下，因此 `.invisible` / `.bottom-full` / `pointer-events-none`
 * 这类初绘必需的工具类与主题 token 都会缺席，两个变体的「隐藏测高」根本不在同一套
 * 样式下运行。
 *
 * 这里在构建期直接扫描两个变体的共同源码（当前 src 树 + 快照 src 树），用 Tailwind
 * 编译出一份静态 CSS，并由 fixture 在 bundle 求值时就注入 `<style>`——早于任何
 * mount / React 渲染。CSS 内容与变体无关，因此哈希在变体之间必须一致。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { uiRoot } from "./chromiumFixture.js";

const REQUIRED_CSS_MARKERS = [
  ".invisible",
  ".bottom-full",
  ".pointer-events-none",
  ".absolute",
  "--color-background",
] as const;

export interface LayoutCostCssArtifact {
  cssText: string;
  cssPath: string;
  cssSha256: string;
  bytes: number;
  candidates: number;
  scanMs: number;
  buildMs: number;
  sourceDirs: string[];
}

const cssCache = new Map<string, Promise<LayoutCostCssArtifact>>();

export interface BuildLayoutCostCssParams {
  outDir: string;
  /** 变体共同源：当前 src 目录 + 快照 src 目录（不存在时忽略）。 */
  sourceDirs: string[];
  /** 缓存/落盘标识，例如 `prechange|timeline`。 */
  key: string;
}

async function scanCandidates(
  sourceDirs: string[],
): Promise<{ candidates: string[]; scanMs: number }> {
  const { Scanner } = (await import("@tailwindcss/oxide")) as typeof import("@tailwindcss/oxide");
  const startedAt = Date.now();
  const scanner = new Scanner({
    sources: sourceDirs.map((base) => ({ base, pattern: "**/*.{ts,tsx,js,jsx}", negated: false })),
  });
  const candidates = scanner.scan();
  return { candidates, scanMs: Date.now() - startedAt };
}

async function compileLayoutCostCss(sourceDirs: string[]): Promise<LayoutCostCssArtifact> {
  const { candidates, scanMs } = await scanCandidates(sourceDirs);
  const sourceCss = await readFile(join(uiRoot, "src/styles.css"), "utf8");
  const { compile } = (await import("@tailwindcss/node")) as typeof import("@tailwindcss/node");
  const startedAt = Date.now();
  const compiler = await compile(sourceCss, {
    base: join(uiRoot, "src"),
    onDependency: () => undefined,
  });
  const cssText = compiler.build([...new Set(candidates)]);
  const buildMs = Date.now() - startedAt;
  const missing = REQUIRED_CSS_MARKERS.filter((marker) => !cssText.includes(marker));
  if (missing.length > 0) {
    throw new Error(`静态产品 CSS 缺少初绘必需项：${missing.join(", ")}`);
  }
  return {
    cssText,
    cssPath: "",
    cssSha256: createHash("sha256").update(cssText).digest("hex"),
    bytes: Buffer.byteLength(cssText),
    candidates: candidates.length,
    scanMs,
    buildMs,
    sourceDirs,
  };
}

/**
 * 生成（或复用）一份启动前可用的静态 CSS。
 *
 * 缓存键包含 outDir 与共同源集合；同一进程内不同变体/表面命中同一份内容，
 * 由调用方断言 `cssSha256` 跨变体一致。
 */
export async function buildLayoutCostCss(
  params: BuildLayoutCostCssParams,
): Promise<LayoutCostCssArtifact> {
  const cacheKey = `${params.outDir}|${params.key}|${params.sourceDirs.join("|")}`;
  const cached = cssCache.get(cacheKey);
  if (cached) return cached;
  const task = (async () => {
    await mkdir(params.outDir, { recursive: true });
    const artifact = await compileLayoutCostCss(params.sourceDirs);
    const cssPath = join(params.outDir, "layout-cost-product.css");
    await writeFile(cssPath, artifact.cssText);
    return { ...artifact, cssPath };
  })();
  cssCache.set(cacheKey, task);
  return task;
}

/** CSS 模块源码：fixture 以 `import { PRODUCT_CSS }` 方式静态引入。 */
export function layoutCostCssModuleSource(cssText: string): string {
  return `// 由 rendererLayoutCostCss.ts 生成；同一运行内两个变体共用同一份内容。\nexport const PRODUCT_CSS = ${JSON.stringify(cssText)};\n`;
}
