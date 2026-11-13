/**
 * prechange / current 的 esbuild 装配（P0-1 修正）。
 *
 * 旧口径把整个快照 repo 当模块根，于是 prechange 与 current 的 `packages/ui/src` 是两个
 * 独立版本（当前工作区还有 23 个与本次对照无关的本地修改），对照差异里混进了外部改动。
 *
 * 现在两个变体都使用**当前工作区 `packages/ui/src` 共享树**，只有本批白名单 4 个模块在
 * esbuild 解析层被替换为快照内容：
 * - 替换在 `onLoad` 上完成：路径仍是当前树里的同一个文件，内容来自快照，`resolveDir`
 *   指向当前文件所在目录，因此它自己的相对导入仍然落到当前共享树；
 * - `AnimatedSidePanePanel.tsx` 不进入 bundle，只作为 sidepane prechange hook 的 AST 来源；
 * - 构建返回共享树哈希、变体树哈希、metafile 输入、CSS 哈希与依赖版本，另把同一 outDir
 *   内两个变体的模块图差异断言写到 `layout-cost-build-report.json`，差异只允许白名单。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { repoRoot, resolveSource, uiRoot } from "./chromiumFixture.js";
import {
  assertLayoutCostVariantParity,
  recordLayoutCostBuild,
} from "./rendererLayoutCostBuildParity.js";
import {
  buildLayoutCostCss,
  layoutCostCssModuleSource,
  type LayoutCostCssArtifact,
} from "./rendererLayoutCostCss.js";
import { PRODUCT_CSS_MODULE } from "./rendererLayoutCostFixtureCss.js";
import { createFixtureSource } from "./rendererLayoutCostFixture.js";
import { generatePrechangeSidePaneHook } from "./rendererLayoutCostPrechangeHook.js";
import { RENDERER_LAYOUT_COST_REPLACED_KEYS } from "./rendererLayoutCostSnapshot.js";
import type {
  RendererLayoutCostSurface,
  RendererLayoutCostVariant,
} from "./rendererLayoutCostTypes.js";
import {
  collectFileHashes,
  hashEntries,
  sharedTreeSha256,
  type FileHashes,
} from "./rendererLayoutCostTreeHash.js";

export { assertLayoutCostVariantParity, generatePrechangeSidePaneHook };

/** 白名单模块（相对 `packages/ui/src`）：prechange 用快照内容、其余文件共用当前树。 */
export const REPLACED_SOURCE_KEYS = RENDERER_LAYOUT_COST_REPLACED_KEYS.map((key) =>
  key.replace(/^packages\/ui\/src\//, ""),
);

/** 真正进入 bundle 的白名单模块（面板只做 AST 抽取）。 */
const BUNDLED_REPLACED_KEYS = REPLACED_SOURCE_KEYS.filter(
  (key) => key !== "app-shell/AnimatedSidePanePanel.tsx",
);

export interface ReplacedModuleInfo {
  key: string;
  currentPath: string;
  snapshotPath: string | null;
  currentSha256: string;
  snapshotSha256: string | null;
  /** 面板只用于 AST 抽取，不进入 bundle。 */
  bundled: boolean;
}

export interface BuiltBundle {
  variant: RendererLayoutCostVariant;
  surface: RendererLayoutCostSurface;
  bundlePath: string;
  bundleSha256: string;
  buildMs: number;
  metafile: { inputs: Record<string, unknown> };
  moduleInputs: string[];
  cssPath: string;
  cssSha256: string;
  cssBytes: number;
  cssCandidates: number;
  cssScanMs: number;
  cssBuildMs: number;
  /** 排除白名单后的共享树哈希：两个变体必须相同。 */
  sharedSourceTreeSha256: string;
  /** 变体完整源码树哈希（prechange 为共享树叠加 4 个快照哈希）。 */
  sourceTreeSha256: string;
  replacedModules: ReplacedModuleInfo[];
  /** 实际由快照内容加载的当前路径（prechange 必须恰好是白名单，current 必须为空）。 */
  snapshotContentUsed: string[];
  dependencyVersions: Record<string, string>;
  /** 本变体自身的模块图断言问题（空数组才是通过）。 */
  inputProblems: string[];
  /** 同一 outDir 内两个变体都构建完成后得到的跨变体差异（空数组才是通过）。 */
  parityProblems: string[];
}

const DEPENDENCY_KEYS = ["react", "react-dom", "esbuild"] as const;

/**
 * 每个表面真正会加载的白名单模块。
 *
 * `sidePaneLayout.ts` 只有侧栏 hook 会用到，时间线/工具栏构建里根本不出现；
 * 断言必须按表面给，否则会把「没有引用」误报成「没有替换」。
 */
const REQUIRED_REPLACED_KEYS: Record<RendererLayoutCostSurface, readonly string[]> = {
  timeline: ["v4/ConversationTimeline.tsx"],
  toolbar: ["prompt-editor/useComposerToolbarFit.ts"],
  sidepane: ["app-shell/sidePaneLayout.ts"],
};

const cssModuleWritten = new Set<string>();
const sharedTreeCache = new Map<string, Promise<FileHashes>>();

function posix(value: string): string {
  return value.split("\\").join("/");
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function loaderOf(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".jsx")) return "jsx";
  return "js";
}

async function sharedTree(): Promise<FileHashes> {
  const root = join(uiRoot, "src");
  const cached = sharedTreeCache.get(root);
  if (cached) return cached;
  const task = collectFileHashes(root);
  sharedTreeCache.set(root, task);
  return task;
}

async function dependencyVersions(): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const key of DEPENDENCY_KEYS) {
    let version = "unresolved";
    for (const candidate of [
      join(repoRoot, "node_modules", key),
      join(uiRoot, "node_modules", key),
    ]) {
      try {
        const parsed = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as {
          version?: string;
        };
        if (parsed.version) {
          version = parsed.version;
          break;
        }
      } catch {
        // 依赖可能只装在其中一个根；继续找。
      }
    }
    versions[key] = version;
  }
  return versions;
}

async function ensureCssModule(outDir: string, css: LayoutCostCssArtifact): Promise<void> {
  const cssModulePath = join(outDir, PRODUCT_CSS_MODULE);
  if (cssModuleWritten.has(cssModulePath)) return;
  await writeFile(cssModulePath, layoutCostCssModuleSource(css.cssText));
  cssModuleWritten.add(cssModulePath);
}

async function replacedModulesOf(
  snapshotUiRoot: string | null,
  files: FileHashes,
): Promise<ReplacedModuleInfo[]> {
  const result: ReplacedModuleInfo[] = [];
  for (const key of REPLACED_SOURCE_KEYS) {
    const currentPath = join(uiRoot, "src", key);
    const snapshotPath = snapshotUiRoot ? join(snapshotUiRoot, "src", key) : null;
    let snapshotSha256: string | null = null;
    if (snapshotPath) {
      try {
        snapshotSha256 = sha256(await readFile(snapshotPath));
      } catch {
        snapshotSha256 = null;
      }
    }
    result.push({
      key: `packages/ui/src/${key}`,
      currentPath,
      snapshotPath,
      currentSha256: files.get(key) ?? "missing",
      snapshotSha256,
      bundled: BUNDLED_REPLACED_KEYS.includes(key as (typeof BUNDLED_REPLACED_KEYS)[number]),
    });
  }
  return result;
}

/**
 * 白名单替换插件：路径保持当前树，内容来自快照。
 *
 * 用 onLoad 而不是 onResolve，是为了让模块图的**路径**在两个变体里完全一致（同一份共享树），
 * 差异只体现在「读了哪个文件的内容」。esbuild 的 metafile 因此仍然记录当前路径，
 * 这里额外记录实际被替换的路径，作为「prechange 确实用了快照内容」的证据。
 */
function redirectPlugin(snapshotUiRoot: string) {
  const replaced = new Map<string, string>();
  for (const key of REPLACED_SOURCE_KEYS) {
    replaced.set(posix(join(uiRoot, "src", key)), join(snapshotUiRoot, "src", key));
  }
  const loaded: string[] = [];
  const plugin = {
    name: "renderer-layout-cost-prechange-redirect",
    setup(builder: import("esbuild").PluginBuild) {
      builder.onLoad({ filter: /\.(?:tsx?|jsx?)$/ }, async (args) => {
        const snapshotPath = replaced.get(posix(args.path));
        if (!snapshotPath) return undefined;
        const contents = await readFile(snapshotPath, "utf8");
        loaded.push(posix(args.path));
        // resolveDir 指向当前树里的同名文件目录：快照模块的相对导入继续落到共享树。
        return { contents, loader: loaderOf(args.path), resolveDir: dirname(args.path) };
      });
    },
  };
  return { plugin, loaded };
}

/**
 * 模块图断言。
 *
 * metafile 的输入路径必须是同一份当前共享树（两个变体一致，不出现快照路径）；
 * prechange 的每个白名单模块都必须由快照内容加载，current 则必须没有任何替换。
 */
function checkVariantInputs(
  variant: RendererLayoutCostVariant,
  surface: RendererLayoutCostSurface,
  inputs: string[],
  snapshotUiRoot: string | null,
  outDir: string,
  loadedFromSnapshot: readonly string[],
): string[] {
  const problems: string[] = [];
  const srcRoot = posix(join(uiRoot, "src"));
  const snapshotSrcRoot = snapshotUiRoot ? posix(join(snapshotUiRoot, "src")) : null;
  const outRoot = posix(resolve(outDir));
  const loaded = new Set(loadedFromSnapshot);
  for (const input of inputs) {
    const path = posix(input);
    if (path.startsWith(outRoot)) continue;
    if (snapshotSrcRoot && path.startsWith(snapshotSrcRoot)) {
      problems.push(`${variant} 的模块图出现了快照路径：${path}`);
      continue;
    }
    if (path.startsWith(srcRoot)) continue;
    if (path.includes("packages/ui/src/")) {
      problems.push(`${variant} 有来源不明的 ui/src 输入：${path}`);
    }
  }
  const whitelist = BUNDLED_REPLACED_KEYS.map((key) => posix(join(uiRoot, "src", key)));
  const required = REQUIRED_REPLACED_KEYS[surface].map((key) => posix(join(uiRoot, "src", key)));
  if (variant === "prechange") {
    for (const path of required) {
      if (!loaded.has(path)) problems.push(`prechange 没有用快照内容替换：${path}`);
    }
    for (const path of loaded) {
      if (!whitelist.includes(path)) problems.push(`prechange 替换了白名单之外的模块：${path}`);
    }
  } else if (loaded.size > 0) {
    problems.push(`current 不应加载任何快照内容：${[...loaded].join(", ")}`);
  }
  return problems;
}

export async function buildSurfaceBundle(params: {
  variant: RendererLayoutCostVariant;
  surface: RendererLayoutCostSurface;
  uiModuleRoot: string;
  outDir: string;
  sidePaneHookPath: string | null;
}): Promise<BuiltBundle> {
  const { build } = await import("esbuild");
  await mkdir(params.outDir, { recursive: true });
  const snapshotUiRoot = params.variant === "prechange" ? params.uiModuleRoot : null;
  const sourceDirs = [join(uiRoot, "src")];
  if (snapshotUiRoot) sourceDirs.push(join(snapshotUiRoot, "src"));
  const css = await buildLayoutCostCss({ outDir: params.outDir, sourceDirs, key: "shared" });
  await ensureCssModule(params.outDir, css);

  const entry = join(params.outDir, `entry-${params.variant}-${params.surface}.tsx`);
  const bundle = join(params.outDir, `bundle-${params.variant}-${params.surface}.js`);
  await writeFile(entry, createFixtureSource(params.surface));
  const redirect = snapshotUiRoot ? redirectPlugin(snapshotUiRoot) : null;

  const startedAt = Date.now();
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    metafile: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    target: ["chrome120"],
    logLevel: "silent",
    nodePaths: [join(uiRoot, "node_modules"), join(repoRoot, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: {
      ".css": "empty",
      ".png": "dataurl",
      ".svg": "dataurl",
      ".webp": "dataurl",
      ".gif": "dataurl",
      ".woff": "dataurl",
      ".woff2": "dataurl",
      ".ttf": "dataurl",
      ".mp3": "dataurl",
      ".wav": "dataurl",
      ".ogg": "dataurl",
      ".m4a": "dataurl",
      ".mp4": "dataurl",
      ".webm": "dataurl",
    },
    plugins: [sourcePlugin(params.sidePaneHookPath), ...(redirect ? [redirect.plugin] : [])],
  });
  const buildMs = Date.now() - startedAt;

  const inputs = Object.keys(result.metafile.inputs).map((input) =>
    resolve(repoRoot, input.split("\\").join("/")),
  );
  const files = await sharedTree();
  const replacedModules = await replacedModulesOf(snapshotUiRoot, files);
  const sharedSha = sharedTreeSha256(files, [...REPLACED_SOURCE_KEYS]);
  const variantFiles = new Map(files);
  if (params.variant === "prechange") {
    for (const module of replacedModules) {
      const relativeKey = module.key.replace(/^packages\/ui\/src\//, "");
      if (module.snapshotSha256) variantFiles.set(relativeKey, module.snapshotSha256);
    }
  }
  const variantTree = hashEntries(variantFiles.entries());

  const built: BuiltBundle = {
    variant: params.variant,
    surface: params.surface,
    bundlePath: bundle,
    bundleSha256: sha256(await readFile(bundle)),
    buildMs,
    metafile: { inputs: result.metafile.inputs as unknown as Record<string, unknown> },
    moduleInputs: inputs,
    cssPath: css.cssPath,
    cssSha256: css.cssSha256,
    cssBytes: css.bytes,
    cssCandidates: css.candidates,
    cssScanMs: css.scanMs,
    cssBuildMs: css.buildMs,
    sharedSourceTreeSha256: sharedSha,
    sourceTreeSha256: variantTree,
    replacedModules,
    /** 实际由快照内容加载的当前路径（prechange 必须恰好是白名单，current 必须为空）。 */
    snapshotContentUsed: redirect ? [...redirect.loaded] : [],
    dependencyVersions: await dependencyVersions(),
    inputProblems: checkVariantInputs(
      params.variant,
      params.surface,
      inputs,
      snapshotUiRoot,
      params.outDir,
      redirect ? redirect.loaded : [],
    ),
    parityProblems: [],
  };
  await recordLayoutCostBuild(params.outDir, built);
  return built;
}

function sourcePlugin(sidePaneHookPath: string | null) {
  return {
    name: "renderer-layout-cost-source",
    setup(builder: import("esbuild").PluginBuild) {
      builder.onResolve({ filter: /^@\/v4\/ConversationTurnGroup\.js$/ }, () => ({
        path: "cost-turn-group",
        namespace: "cost-module",
      }));
      if (sidePaneHookPath) {
        builder.onResolve({ filter: /^@\/app-shell\/useSidePaneTabsOverflow\.js$/ }, () => ({
          path: sidePaneHookPath,
        }));
      }
      builder.onLoad({ filter: /.*/, namespace: "cost-module" }, () => ({
        loader: "tsx",
        resolveDir: uiRoot,
        contents: [
          'import { memo } from "react";',
          `import { ConversationTurnGroup as RealTurnGroup } from ${JSON.stringify(
            posix(join(uiRoot, "src/v4/ConversationTurnGroup.tsx")),
          )};`,
          "export const ConversationTurnGroup = memo(function CostCountingTurnGroup(props) {",
          "  const unit = props.unit;",
          '  const turnId = unit && unit.turnId ? unit.turnId : "unknown";',
          "  const counts = globalThis.__costTurnCounts || (globalThis.__costTurnCounts = new Map());",
          "  const entry = counts.get(turnId) || { count: 0, isRunning: false };",
          "  entry.count += 1;",
          "  entry.isRunning = Boolean(unit && unit.isRunning);",
          "  counts.set(turnId, entry);",
          "  return <RealTurnGroup {...props} />;",
          "});",
        ].join("\n"),
      }));
      builder.onResolve({ filter: /\?(?:url|raw)$/ }, () => ({
        path: "asset-url-stub",
        namespace: "asset-url-stub",
      }));
      builder.onLoad({ filter: /.*/, namespace: "asset-url-stub" }, () => ({
        contents: "export default '';",
        loader: "js",
      }));
      builder.onResolve({ filter: /^@\// }, async (args) => {
        const path = await resolveSource(join(uiRoot, "src", args.path.slice(2)));
        return path ? { path } : undefined;
      });
      builder.onResolve({ filter: /\.js$/ }, async (args) => {
        if (!args.path.startsWith(".")) return undefined;
        const path = await resolveSource(join(args.resolveDir, args.path));
        return path ? { path } : undefined;
      });
    },
  };
}
