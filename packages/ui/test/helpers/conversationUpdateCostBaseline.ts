/** 基线副本加载，以及从基线 SessionPane AST 提取真实派生表达式。 */
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

import { repoRoot, resolveSource, uiRoot } from "./chromiumFixture.js";
import type { BaselineSources, CurrentSources } from "./conversationUpdateCostTypes.js";

/** 基线副本入口：只从环境变量读取，避免把某台机器的时间戳目录写进测试。 */
export function resolveBaselineManifestPath(): string | null {
  const explicit = process.env.YCODE_UPDATE_COST_BASELINE?.trim();
  return explicit ? explicit : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function manifestFilePath(manifestDir: string, key: string): string | null {
  return key ? join(manifestDir, key) : null;
}

/**
 * 基线对照真正依赖的文件。manifest 里还有 lockfile、补丁等记录，但它们不参与
 * 构建；这五项决定 baseline 变体是否仍是“修复前源码”。缺哈希或真实文件哈希不匹配
 * 时必须显式失败，不能静默退回当前构建。
 */
export const REQUIRED_BASELINE_KEYS = [
  "repo/packages/ui/src/v4/ConversationTimeline.tsx",
  "repo/packages/ui/src/v4/SessionPane.tsx",
  "repo/packages/ui/src/v4/pendingGuideProjection.ts",
  "node_modules/@radix-ui/react-select@2.2.6/dist/index.mjs",
  "node_modules/@radix-ui/react-scroll-area@1.2.10/dist/index.mjs",
] as const;

/** 比较 manifest 声明哈希与真实文件哈希，返回可读的不一致列表（纯函数，便于单测）。 */
export function findManifestHashMismatches(
  expected: Record<string, string | undefined>,
  actual: Record<string, string | undefined>,
  keys: readonly string[] = REQUIRED_BASELINE_KEYS,
): string[] {
  const mismatches: string[] = [];
  for (const key of keys) {
    const want = expected[key];
    const got = actual[key];
    if (!want) mismatches.push(`${key}: manifest 缺少 sha256`);
    else if (!got) mismatches.push(`${key}: 真实文件不存在或无法计算哈希`);
    else if (want !== got) mismatches.push(`${key}: manifest=${want} actual=${got}`);
  }
  return mismatches;
}

/**
 * 从基线 SessionPane 的 AST 提取真实派生表达式，而不是手写一份“等价”逻辑。
 * knownSessionIds 复用原 useMemo 回调与依赖数组；pending 投影复用原调用表达式。
 */
export function extractBaselineDerivedSource(
  sessionPaneSource: string,
  pendingGuideProjectionPath: string,
): string {
  const file = ts.createSourceFile(
    "SessionPane.tsx",
    sessionPaneSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: { knownCallback?: string; knownDeps?: string; pending?: string } = {};
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(file) === "useMemo"
    ) {
      const [callback, deps] = node.initializer.arguments;
      if (node.name.text === "knownSessionIds" && callback && deps) {
        found.knownCallback = callback.getText(file);
        found.knownDeps = deps.getText(file);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "pendingGuideProjection" &&
      node.initializer
    ) {
      found.pending = node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found.knownCallback || !found.knownDeps || !found.pending) {
    throw new Error(
      "基线 SessionPane 未找到 knownSessionIds/pendingGuideProjection 的可提取表达式",
    );
  }
  const modulePath = pendingGuideProjectionPath.replace(/\\/g, "/");
  return [
    'import { useMemo } from "react";',
    `import { projectPendingGuideQueue } from ${JSON.stringify(modulePath)};`,
    "",
    "// 以下 input 字段名对齐基线 SessionPane 的局部变量，回调与依赖数组原文照搬。",
    "export function useBaselineKnownSessionIds(input) {",
    "  const sessionScopeReady = input.sessionScopeReady;",
    "  const sessionIndexScopes = { length: input.sessionIndexScopeCount };",
    "  const hydratingEndpointKeys = { length: input.hydratingEndpointCount };",
    "  const archivedTasksForCitation = { items: input.archivedItems, loading: input.archivedLoading };",
    "  const sessionIndexItems = input.sessionIndexItems;",
    "  const taskQueryCacheForCitation = input.taskMetaByEntityKey;",
    "  const sessionId = input.sessionId;",
    `  return useMemo(${found.knownCallback}, ${found.knownDeps});`,
    "}",
    "",
    "export function useBaselinePendingGuideProjection(queue) {",
    "  const snapshot = { queue };",
    `  return ${found.pending};`,
    "}",
    "",
  ].join("\n");
}

export async function loadBaselineSources(): Promise<{
  manifestPath: string;
  sources: BaselineSources | null;
}> {
  const manifestPath = resolveBaselineManifestPath();
  if (!manifestPath || !(await exists(manifestPath)))
    return { manifestPath: manifestPath ?? "", sources: null };
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    files: Record<string, { sha256: string }>;
  };
  const manifestDir = manifestPath.slice(
    0,
    Math.max(manifestPath.lastIndexOf("/"), manifestPath.lastIndexOf("\\")),
  );
  const files = manifest.files ?? {};
  const hashes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(files)) hashes[key] = entry.sha256;
  const timeline = manifestFilePath(
    manifestDir,
    "repo/packages/ui/src/v4/ConversationTimeline.tsx",
  );
  const radixSelect = manifestFilePath(
    manifestDir,
    "node_modules/@radix-ui/react-select@2.2.6/dist/index.mjs",
  );
  const radixScrollArea = manifestFilePath(
    manifestDir,
    "node_modules/@radix-ui/react-scroll-area@1.2.10/dist/index.mjs",
  );
  const sessionPane = manifestFilePath(manifestDir, "repo/packages/ui/src/v4/SessionPane.tsx");
  const pendingGuideProjection = manifestFilePath(
    manifestDir,
    "repo/packages/ui/src/v4/pendingGuideProjection.ts",
  );
  if (!timeline || !radixSelect || !radixScrollArea || !sessionPane || !pendingGuideProjection) {
    return { manifestPath, sources: null };
  }
  const requiredPaths: Record<string, string> = {
    "repo/packages/ui/src/v4/ConversationTimeline.tsx": timeline,
    "repo/packages/ui/src/v4/SessionPane.tsx": sessionPane,
    "repo/packages/ui/src/v4/pendingGuideProjection.ts": pendingGuideProjection,
    "node_modules/@radix-ui/react-select@2.2.6/dist/index.mjs": radixSelect,
    "node_modules/@radix-ui/react-scroll-area@1.2.10/dist/index.mjs": radixScrollArea,
  };
  const missing = (
    await Promise.all(
      REQUIRED_BASELINE_KEYS.map(async (key) =>
        (await exists(requiredPaths[key])) ? null : requiredPaths[key],
      ),
    )
  ).filter((path): path is string => path !== null);
  if (missing.length > 0) {
    // manifest 存在但必需文件缺失：这是损坏的基线输入，不是“没有基线”，
    // 继续运行会把 baseline 变体退化成当前构建并产出错误结论。
    throw new Error(`基线副本缺少必需文件（manifest=${manifestPath}）：${missing.join(", ")}`);
  }
  // 记录哈希还不够：必须确认真实文件与 manifest 一致，避免被改过的基线冒充修复前源码。
  const actualHashes: Record<string, string> = {};
  for (const key of REQUIRED_BASELINE_KEYS) actualHashes[key] = await hashFile(requiredPaths[key]);
  const mismatches = findManifestHashMismatches(hashes, actualHashes);
  if (mismatches.length > 0) {
    throw new Error(
      `基线文件哈希与 manifest 不一致，拒绝把被修改的基线当作对照组：\n${mismatches.join("\n")}`,
    );
  }
  const derivedSource = extractBaselineDerivedSource(
    await readFile(sessionPane, "utf8"),
    pendingGuideProjection,
  );
  return {
    manifestPath,
    sources: {
      timeline,
      radixSelect,
      radixScrollArea,
      pendingGuideProjection,
      derivedSource,
      hashes,
    },
  };
}

export async function loadCurrentSources(): Promise<CurrentSources> {
  const timeline = await resolveSource(join(uiRoot, "src/v4/ConversationTimeline.tsx"));
  const radixSelect = join(repoRoot, "node_modules/@radix-ui/react-select/dist/index.mjs");
  const radixScrollArea = join(repoRoot, "node_modules/@radix-ui/react-scroll-area/dist/index.mjs");
  if (!timeline) throw new Error("找不到当前 ConversationTimeline");
  const sessionPane = join(uiRoot, "src/v4/SessionPane.tsx");
  const pendingGuideProjection = join(uiRoot, "src/v4/pendingGuideProjection.ts");
  const sessionPaneDerivedInputs = join(uiRoot, "src/v4/sessionPaneDerivedInputs.ts");
  return {
    timeline,
    timelineHash: await hashFile(timeline),
    radixSelect,
    radixSelectHash: (await exists(radixSelect)) ? await hashFile(radixSelect) : "missing",
    radixScrollArea,
    radixScrollAreaHash: (await exists(radixScrollArea))
      ? await hashFile(radixScrollArea)
      : "missing",
    sessionPane,
    sessionPaneHash: (await exists(sessionPane)) ? await hashFile(sessionPane) : "missing",
    pendingGuideProjection,
    pendingGuideProjectionHash: (await exists(pendingGuideProjection))
      ? await hashFile(pendingGuideProjection)
      : "missing",
    sessionPaneDerivedInputs,
    sessionPaneDerivedInputsHash: (await exists(sessionPaneDerivedInputs))
      ? await hashFile(sessionPaneDerivedInputs)
      : "missing",
  };
}
