/**
 * prechange 侧栏 bounded hook：从快照面板 AST 抽取真实 overflow effect。
 *
 * 只是测试 bundle 用的有界 hook，不是完整 owner：只包含面板里的 mask 类型、空 mask
 * 常量、state 声明与 overflow effect；effect 正文逐字取自快照原文，仅把两个组件
 * ref 换成参数 ref。禁止手写近似算法，也不把该文件计入「完整面板」的实测范围。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

export const PRECHANGE_SIDE_PANE_HOOK_FILE = "useSidePaneTabsOverflow.ts";

export async function generatePrechangeSidePaneHook(
  uiModuleRoot: string,
  outDir: string,
): Promise<string> {
  const panelPath = join(uiModuleRoot, "src/app-shell/AnimatedSidePanePanel.tsx");
  const source = await readFile(panelPath, "utf8");
  const file = ts.createSourceFile(
    "AnimatedSidePanePanel.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const ranges: { maskType?: string; emptyEdges?: string; effect?: string } = {};
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "TabsScrollMaskEdges") {
      ranges.maskType = node.getText(file);
    }
    if (
      ts.isVariableStatement(node) &&
      node.getText(file).includes("EMPTY_TABS_SCROLL_MASK_EDGES")
    ) {
      ranges.emptyEdges = node.getText(file);
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const text = node.getText(file);
      if (
        call.expression.getText(file) === "useEffect" &&
        text.includes('viewport.addEventListener("scroll"') &&
        text.includes("updateOverflowState")
      ) {
        ranges.effect = text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!ranges.maskType || !ranges.emptyEdges || !ranges.effect) {
    throw new Error(
      `prechange 面板未找到可提取的 overflow effect（${panelPath}）：` +
        `maskType=${Boolean(ranges.maskType)} emptyEdges=${Boolean(ranges.emptyEdges)} effect=${Boolean(ranges.effect)}`,
    );
  }
  // 面板里 effect 开头读的是组件 ref；只替换这两个标识符，其余正文保持原文。
  const effect = ranges.effect
    .replaceAll("tabsScrollViewportRef", "viewportRef")
    .replaceAll("tabsScrollContentRef", "contentRef");
  const moduleSource = [
    "// 仅测试 bundle 使用：由 prechange 面板原文抽取的 bounded hook（不是完整 owner）。",
    'import { useEffect, useState, type RefObject } from "react";',
    'import { resolveSidePaneTabsOverflow } from "@/app-shell/sidePaneLayout.js";',
    ranges.maskType,
    ranges.emptyEdges,
    "type VisibleSidePaneTab = { id: string };",
    "export function useSidePaneTabsOverflow(params: {",
    "  viewportRef: RefObject<HTMLDivElement | null>;",
    "  contentRef: RefObject<HTMLDivElement | null>;",
    "  visibleTabs: readonly VisibleSidePaneTab[];",
    "}) {",
    "  const { viewportRef, contentRef, visibleTabs } = params;",
    "  const [isTabsOverflowing, setIsTabsOverflowing] = useState(false);",
    "  const [tabsScrollMaskEdges, setTabsScrollMaskEdges] = useState<TabsScrollMaskEdges>({",
    "    left: false,",
    "    right: false,",
    "  });",
    effect,
    "  return { isOverflowing: isTabsOverflowing, maskEdges: tabsScrollMaskEdges };",
    "}",
    "",
  ].join("\n");
  const directory = join(outDir, "prechange-hook");
  await mkdir(directory, { recursive: true });
  const hookPath = join(directory, PRECHANGE_SIDE_PANE_HOOK_FILE);
  await writeFile(hookPath, moduleSource);
  return hookPath;
}
