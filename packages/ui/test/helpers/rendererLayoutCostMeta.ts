/**
 * 运行结果与代码的绑定。
 *
 * 结果必须能回指到确切的源码：记录测试/harness/build/probes 文件、被测模块、依赖版本、
 * git HEAD 与 dirty 状态，以及 prechange 快照哈希。落盘后再次计算同一指纹；任一字段
 * 变化即 `frozen=false`，报告层不得把该结果当作同一份代码的对照。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { repoRoot, uiRoot } from "./chromiumFixture.js";
import type { SourceFingerprint } from "./rendererLayoutCostTypes.js";

/** harness 自身的源文件；结果一旦落盘，这些文件不得再改。 */
export const HARNESS_SOURCE_KEYS = [
  "packages/ui/test/rendererLayoutCostBrowser.test.ts",
  "packages/ui/test/helpers/rendererLayoutCostHarness.ts",
  "packages/ui/test/helpers/rendererLayoutCostTypes.ts",
  "packages/ui/test/helpers/rendererLayoutCostProbes.ts",
  "packages/ui/test/helpers/rendererLayoutCostMeta.ts",
  "packages/ui/test/helpers/rendererLayoutCostMeasurement.ts",
  "packages/ui/test/helpers/rendererLayoutCostSampling.ts",
  "packages/ui/test/helpers/rendererLayoutCostSummary.ts",
  "packages/ui/test/helpers/rendererLayoutCostScenarios.ts",
  "packages/ui/test/helpers/rendererLayoutCostScenariosUi.ts",
  "packages/ui/test/helpers/rendererLayoutCostPageSignals.ts",
  "packages/ui/test/helpers/rendererLayoutCostCoverage.ts",
  "packages/ui/test/helpers/rendererLayoutCostAcceptance.ts",
  "packages/ui/test/helpers/rendererLayoutCostRestoreCheck.ts",
  "packages/ui/test/helpers/rendererLayoutCostBuild.ts",
  "packages/ui/test/helpers/rendererLayoutCostBuildParity.ts",
  "packages/ui/test/helpers/rendererLayoutCostCss.ts",
  "packages/ui/test/helpers/rendererLayoutCostFixture.ts",
  "packages/ui/test/helpers/rendererLayoutCostFixtureCss.ts",
  "packages/ui/test/helpers/rendererLayoutCostFixtureSidePane.ts",
  "packages/ui/test/helpers/rendererLayoutCostFixtureTimeline.ts",
  "packages/ui/test/helpers/rendererLayoutCostFixtureTimelineData.ts",
  "packages/ui/test/helpers/rendererLayoutCostFixtureToolbar.ts",
  "packages/ui/test/helpers/rendererLayoutCostPrechangeHook.ts",
  "packages/ui/test/helpers/rendererLayoutCostSnapshot.ts",
  "packages/ui/test/helpers/rendererLayoutCostTreeHash.ts",
  "packages/ui/test/helpers/chromiumFixture.ts",
  "packages/ui/test/helpers/conversationUpdateCostPage.ts",
  "packages/ui/test/helpers/conversationUpdateCostTrace.ts",
] as const;

/**
 * 实际进入被测 bundle 的模块；current 新 hook 与真实 store 也在内。
 * `SessionPane.tsx` 只被 Timeline 间接渲染，不做单独断言，也不挂名。
 */
export const MEASURED_MODULE_KEYS = [
  "packages/ui/src/v4/ConversationTimeline.tsx",
  "packages/ui/src/v4/ConversationTurnGroup.tsx",
  "packages/ui/src/v4/conversationProjectionStore.ts",
  "packages/ui/src/prompt-editor/useComposerToolbarFit.ts",
  "packages/ui/src/app-shell/sidePaneLayout.ts",
  "packages/ui/src/app-shell/useSidePaneTabsOverflow.ts",
] as const;

/** 影响 fixture 生成或产品 CSS，但不直接计入实测模块的源文件。 */
export const SUPPORT_SOURCE_KEYS = [
  "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
  "packages/ui/src/styles.css",
] as const;

export const DEPENDENCY_KEYS = [
  "react",
  "react-dom",
  "esbuild",
  "playwright-core",
  "tailwindcss",
  "typescript",
] as const;

export async function hashFileIfExists(path: string): Promise<string> {
  try {
    await access(path);
  } catch {
    return "missing";
  }
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function posix(key: string): string {
  return key.replace(/\\/g, "/");
}

async function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoRoot, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function dependencyVersion(pkg: string): Promise<string> {
  const candidates = [
    join(uiRoot, "node_modules", pkg, "package.json"),
    join(repoRoot, "node_modules", pkg, "package.json"),
    join(repoRoot, "packages", "desktop", "node_modules", pkg, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // pnpm 可能把依赖只装在某个包的 node_modules；继续找下一个根。
    }
  }
  return "unresolved";
}

export interface FingerprintSnapshot {
  manifestPath: string;
  manifestSha256: string;
  manifestSidecarSha256?: string | null;
  manifestFileCount?: number;
  uiModuleRoot: string;
  hashes: Record<string, string>;
  replacedKeys?: string[];
  astOnlyKeys?: string[];
  notMeasuredKeys?: string[];
  currentOnlyHashes?: Record<string, string>;
}

export async function collectSourceFingerprint(
  snapshot: FingerprintSnapshot,
  moduleInputs: string[] | null,
): Promise<SourceFingerprint> {
  const sourceHashes: Record<string, string> = {};
  for (const key of [...HARNESS_SOURCE_KEYS, ...MEASURED_MODULE_KEYS, ...SUPPORT_SOURCE_KEYS]) {
    sourceHashes[posix(key)] = await hashFileIfExists(join(repoRoot, key));
  }
  const dependencyVersions: Record<string, string> = {};
  for (const key of DEPENDENCY_KEYS) dependencyVersions[key] = await dependencyVersion(key);
  const [head, branch, status] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["status", "--porcelain"]),
  ]);
  const dirtyEntries = status ? status.split("\n").filter(Boolean).length : 0;
  return {
    gitHead: head,
    gitBranch: branch,
    dirty: dirtyEntries > 0,
    dirtyEntries,
    sourceHashes,
    dependencyVersions,
    moduleInputs,
    snapshot: {
      manifestPath: snapshot.manifestPath,
      manifestSha256: snapshot.manifestSha256,
      manifestSidecarSha256: snapshot.manifestSidecarSha256 ?? null,
      manifestFileCount: snapshot.manifestFileCount ?? null,
      uiModuleRoot: snapshot.uiModuleRoot,
      hashes: snapshot.hashes,
      replacedKeys: snapshot.replacedKeys ?? [],
      astOnlyKeys: snapshot.astOnlyKeys ?? [],
      notMeasuredKeys: snapshot.notMeasuredKeys ?? [],
      currentOnlyHashes: snapshot.currentOnlyHashes ?? {},
    },
    computedAt: new Date().toISOString(),
  };
}

/**
 * 比较与「代码内容」相关的字段。
 *
 * 不比较 dirtyEntries：并发工作可能新增与本矩阵无关的未跟踪文件，数量变化
 * 不代表被测源码变化；被测文件的增删改会直接反映在 sourceHashes 的
 * sha256 / "missing" 上。gitHead 与依赖、快照仍然必须一致。
 */
export function fingerprintSourcesMatch(
  before: SourceFingerprint,
  after: SourceFingerprint,
): boolean {
  return (
    before.gitHead === after.gitHead &&
    JSON.stringify(before.sourceHashes) === JSON.stringify(after.sourceHashes) &&
    JSON.stringify(before.dependencyVersions) === JSON.stringify(after.dependencyVersions) &&
    JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot)
  );
}

export function fingerprintMatches(
  before: SourceFingerprint,
  after: SourceFingerprint | null,
): boolean {
  if (!after) return false;
  return (
    fingerprintSourcesMatch(before, after) &&
    JSON.stringify(before.moduleInputs) === JSON.stringify(after.moduleInputs)
  );
}
