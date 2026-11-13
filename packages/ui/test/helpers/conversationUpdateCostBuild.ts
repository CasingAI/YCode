/** 五变体的构建期 alias、虚拟基线与 esbuild 装配。 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { repoRoot, resolveSource, uiRoot } from "./chromiumFixture.js";
import { createConversationUpdateCostFixtureSource } from "./conversationUpdateCostFixture.js";
import type {
  BaselineSources,
  DerivedMode,
  VariantDefinition,
} from "./conversationUpdateCostTypes.js";

export function buildVariantDefinitions(): VariantDefinition[] {
  return [
    {
      id: "baseline",
      timeline: "baseline",
      radix: "baseline",
      derived: "baseline",
      note: "基线 SessionPane AST 派生 + 旧 pending 投影，每帧重建",
    },
    {
      id: "timeline-only",
      timeline: "current",
      radix: "baseline",
      derived: "baseline",
      note: "只替换 Timeline；Radix 与基线派生引用保持修复前",
    },
    {
      id: "radix-only",
      timeline: "baseline",
      radix: "current",
      derived: "baseline",
      note: "只替换 Radix；Timeline 与基线派生引用保持修复前",
    },
    {
      id: "derived-only",
      timeline: "baseline",
      radix: "baseline",
      derived: "current",
      note: "只接真实 useStableKnownSessionIdSet/useStablePendingGuideProjection",
    },
    {
      id: "combined",
      timeline: "current",
      radix: "current",
      derived: "current",
      note: "当前工作区组合",
    },
  ];
}

export interface BuildArtifacts {
  key: string;
  bundlePath: string;
  buildMs: number;
}

function costModulesPlugin(timelinePath: string, turnGroupPath: string) {
  return {
    name: "cost-modules",
    setup(builder: import("esbuild").PluginBuild) {
      builder.onResolve({ filter: /^@\/v4\/ConversationTimeline\.js$/ }, () => ({
        path: "cost-timeline",
        namespace: "cost-module",
      }));
      builder.onResolve({ filter: /^@\/v4\/ConversationTurnGroup\.js$/ }, () => ({
        path: "cost-turn-group",
        namespace: "cost-module",
      }));
      builder.onResolve({ filter: /^@\/v4\/conversationTimelineDebug\.js$/ }, () => ({
        path: "cost-timeline-debug",
        namespace: "cost-module",
      }));
      builder.onLoad({ filter: /.*/, namespace: "cost-module" }, (args) => {
        if (args.path === "cost-timeline") {
          return {
            loader: "tsx",
            resolveDir: uiRoot,
            contents: [
              'import { memo } from "react";',
              `import { ConversationTimeline as RealTimeline } from ${JSON.stringify(timelinePath.replace(/\\/g, "/"))};`,
              "export const ConversationTimeline = memo(function CostCountingConversationTimeline(props) {",
              "  globalThis.__costTimelineRenders = (globalThis.__costTimelineRenders || 0) + 1;",
              "  return <RealTimeline {...props} />;",
              "});",
            ].join("\n"),
          };
        }
        if (args.path === "cost-turn-group") {
          return {
            loader: "tsx",
            resolveDir: uiRoot,
            contents: [
              'import { memo } from "react";',
              `import { ConversationTurnGroup as RealTurnGroup } from ${JSON.stringify(turnGroupPath.replace(/\\/g, "/"))};`,
              "export const ConversationTurnGroup = memo(function CostCountingConversationTurnGroup(props) {",
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
          };
        }
        // 基线与当前构建都把 Timeline 诊断模块替换为 no-op：对照只覆盖几何读取、
        // DOM 写入与派生引用，不包含真实 logger/timer 成本，不能据此推断日志开销。
        return {
          loader: "js",
          resolveDir: uiRoot,
          contents: "export function recordConversationTimelineDebugEvent() {}",
        };
      });
    },
  };
}

function radixBaselinePlugin(baseline: BaselineSources | null) {
  return {
    name: "cost-radix-baseline",
    setup(builder: import("esbuild").PluginBuild) {
      if (!baseline) return;
      const mapping: Record<string, string> = {
        "@radix-ui/react-select": baseline.radixSelect,
        "@radix-ui/react-scroll-area": baseline.radixScrollArea,
      };
      builder.onResolve({ filter: /^@radix-ui\/react-(select|scroll-area)$/ }, (args) =>
        mapping[args.path] ? { path: mapping[args.path] } : undefined,
      );
    },
  };
}

function derivedBaselinePlugin(baseline: BaselineSources | null) {
  return {
    name: "cost-derived-baseline",
    setup(builder: import("esbuild").PluginBuild) {
      builder.onResolve({ filter: /^@\/v4\/sessionPaneDerivedBaseline\.js$/ }, () => ({
        path: "cost-derived-baseline",
        namespace: "cost-derived-baseline",
      }));
      builder.onLoad({ filter: /.*/, namespace: "cost-derived-baseline" }, () => {
        if (!baseline) throw new Error("baseline 派生模块缺失");
        return { contents: baseline.derivedSource, loader: "ts", resolveDir: uiRoot };
      });
    },
  };
}

function uiSourcePlugin() {
  return {
    name: "cost-ui-source",
    setup(builder: import("esbuild").PluginBuild) {
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

export async function buildBundle(params: {
  directory: string;
  key: string;
  timelinePath: string;
  radixBaseline: boolean;
  derived: DerivedMode;
  baseline: BaselineSources | null;
}): Promise<BuildArtifacts> {
  const { build } = await import("esbuild");
  const fixtureSource = createConversationUpdateCostFixtureSource(params.derived);
  const entry = join(params.directory, `entry-${params.key}.tsx`);
  const bundle = join(params.directory, `bundle-${params.key}.js`);
  await writeFile(entry, fixtureSource);
  const turnGroup = await resolveSource(join(uiRoot, "src/v4/ConversationTurnGroup.tsx"));
  if (!turnGroup) throw new Error("找不到当前 ConversationTurnGroup");
  const startedAt = Date.now();
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
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
    plugins: [
      costModulesPlugin(params.timelinePath, turnGroup),
      radixBaselinePlugin(params.radixBaseline ? params.baseline : null),
      derivedBaselinePlugin(params.derived === "baseline" ? params.baseline : null),
      uiSourcePlugin(),
    ],
  });
  return { key: params.key, bundlePath: bundle, buildMs: Date.now() - startedAt };
}
