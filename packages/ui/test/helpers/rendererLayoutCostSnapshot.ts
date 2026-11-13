/**
 * prechange 完整性快照读取（P0-1 修正）。
 *
 * 本批不再把整个快照 repo 当模块根：prechange 构建使用**当前工作区的公用 src 树**，
 * 只把白名单里的 4 个模块替换为快照版本。因此这里只负责：
 * - 校验 manifest 与 sidecar 哈希，并要求快照目录在仓库之外（不干扰外部工作）；
 * - 校验 4 个白名单文件的快照哈希与 manifest 记录一致；
 * - 记录 current 独有的新模块 `useSidePaneTabsOverflow.ts` 的哈希（快照里没有它）；
 * - 标明 `AnimatedSidePanePanel.tsx` 只用于 AST 抽取 bounded hook，不声称完整 owner；
 * - 标明 `SessionPane.tsx` 未参与实测：不校验、不挂名。
 */
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { repoRoot, resolveSource, uiRoot } from "./chromiumFixture.js";

/**
 * prechange 构建里由快照替换的模块（白名单）。
 *
 * 除这些文件之外，两个变体都解析到同一份当前 src 树；构建期会断言模块图差异
 * 不超出该白名单（见 rendererLayoutCostBuild.ts）。
 */
export const RENDERER_LAYOUT_COST_REPLACED_KEYS = [
  "packages/ui/src/v4/ConversationTimeline.tsx",
  "packages/ui/src/prompt-editor/useComposerToolbarFit.ts",
  "packages/ui/src/app-shell/sidePaneLayout.ts",
  "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
] as const;

/** current 才有的模块：快照里不存在，构建前显式记录当前哈希。 */
export const RENDERER_LAYOUT_COST_CURRENT_ONLY_KEYS = [
  "packages/ui/src/app-shell/useSidePaneTabsOverflow.ts",
] as const;

/**
 * 只做 AST 抽取的模块：不进入 bundle，也不代表完整产品 owner。
 * 侧栏 prechange hook 的 effect 正文逐字取自该面板原文。
 */
export const RENDERER_LAYOUT_COST_AST_ONLY_KEYS = [
  "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
] as const;

/**
 * 本批未实测的模块：`SessionPane.tsx` 只被 Timeline 间接渲染，fixture 不对它做
 * 任何单独断言，也不把它的哈希写进「被测模块」名单。
 */
export const RENDERER_LAYOUT_COST_NOT_MEASURED_KEYS = [
  "packages/ui/src/v4/SessionPane.tsx",
] as const;

export interface RendererLayoutCostSnapshot {
  manifestPath: string;
  manifestSha256: string;
  /** manifest 旁的 `<hash>  manifest.json` 记录；缺失时为 null。 */
  manifestSidecarSha256: string | null;
  repoRoot: string;
  uiModuleRoot: string;
  /** 白名单 4 个文件在快照中的哈希。 */
  hashes: Record<string, string>;
  manifestFileCount: number;
  replacedKeys: string[];
  astOnlyKeys: string[];
  notMeasuredKeys: string[];
  /** current 独有模块在工作区的哈希；缺失记为 "missing"。 */
  currentOnlyHashes: Record<string, string>;
}

interface ManifestFile {
  key: string;
  category: string;
  path: string;
  sha256: string;
  bytes: number;
}

interface Manifest {
  copy?: { root?: string; files?: ManifestFile[] };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** 环境变量显式指向 manifest；未设置时返回 null，不猜测时间戳目录。 */
export function resolveManifestPath(): string | null {
  const value =
    process.env.YCODE_RENDERER_LAYOUT_COST_BASELINE?.trim() ||
    process.env.YCODE_RENDERER_LAYOUT_COST_PREHANCE?.trim();
  return value || null;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
}

async function readSidecarSha256(manifestPath: string): Promise<string | null> {
  const sidecar = join(resolve(manifestPath, ".."), "manifest.sha256");
  if (!(await exists(sidecar))) return null;
  const raw = (await readFile(sidecar, "utf8")).trim();
  const token = raw.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : `unexpected:${raw.slice(0, 80)}`;
}

export function snapshotFileOf(
  snapshot: Pick<RendererLayoutCostSnapshot, "repoRoot">,
  key: string,
): string {
  return join(snapshot.repoRoot, key);
}

export async function loadPrechangeSnapshot(): Promise<
  { skipped: string } | { snapshot: RendererLayoutCostSnapshot }
> {
  const manifestPath = resolveManifestPath();
  if (!manifestPath) {
    return {
      skipped:
        "未设置 YCODE_RENDERER_LAYOUT_COST_BASELINE；prechange 对照跳过（不能把 current 当作 baseline）",
    };
  }
  if (!(await exists(manifestPath))) return { skipped: `manifest 不存在: ${manifestPath}` };
  const raw = await readFile(manifestPath, "utf8");
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  const sidecarSha256 = await readSidecarSha256(manifestPath);
  if (sidecarSha256 !== null && sidecarSha256 !== manifestSha256) {
    throw new Error(
      `快照 manifest 与 sidecar 不一致: manifest=${manifestSha256} sidecar=${sidecarSha256}`,
    );
  }
  const manifest = JSON.parse(raw) as Manifest;
  const snapshotRepoRoot = manifest.copy?.root;
  const files = manifest.copy?.files ?? [];
  if (!snapshotRepoRoot || files.length === 0) {
    throw new Error(`快照 manifest 缺少 copy.root 或 copy.files: ${manifestPath}`);
  }
  if (isInside(repoRoot, snapshotRepoRoot) || isInside(snapshotRepoRoot, repoRoot)) {
    throw new Error(
      `快照目录必须位于工作区仓库之外（避免 prechange 构建与本地工作互相干扰）: ${snapshotRepoRoot}`,
    );
  }
  const byKey = new Map(files.map((file) => [file.key, file]));
  const hashes: Record<string, string> = {};
  const problems: string[] = [];
  for (const key of RENDERER_LAYOUT_COST_REPLACED_KEYS) {
    const record = byKey.get(key);
    const path = join(snapshotRepoRoot, key);
    if (!record) {
      problems.push(`${key}: manifest 未记录`);
      continue;
    }
    if (!(await exists(path))) {
      problems.push(`${key}: 快照文件不存在 ${path}`);
      continue;
    }
    const actual = await hashFile(path);
    if (actual !== record.sha256) {
      problems.push(`${key}: manifest=${record.sha256} actual=${actual}`);
      continue;
    }
    hashes[key] = actual;
  }
  if (problems.length > 0) {
    throw new Error(`prechange 快照校验失败:\n${problems.join("\n")}`);
  }
  const currentOnlyHashes = await loadCurrentOnlyHashes();
  return {
    snapshot: {
      manifestPath,
      manifestSha256,
      manifestSidecarSha256: sidecarSha256,
      repoRoot: snapshotRepoRoot,
      uiModuleRoot: join(snapshotRepoRoot, "packages/ui"),
      hashes,
      manifestFileCount: files.length,
      replacedKeys: [...RENDERER_LAYOUT_COST_REPLACED_KEYS],
      astOnlyKeys: [...RENDERER_LAYOUT_COST_AST_ONLY_KEYS],
      notMeasuredKeys: [...RENDERER_LAYOUT_COST_NOT_MEASURED_KEYS],
      currentOnlyHashes,
    },
  };
}

async function loadCurrentOnlyHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const key of RENDERER_LAYOUT_COST_CURRENT_ONLY_KEYS) {
    const path = join(repoRoot, key);
    hashes[key] = (await exists(path)) ? await hashFile(path) : "missing";
  }
  return hashes;
}

/** 当前工作区白名单与 current 独有模块的哈希；不覆盖其他本地改动。 */
export async function loadCurrentHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const key of RENDERER_LAYOUT_COST_REPLACED_KEYS) {
    const path = join(repoRoot, key);
    hashes[key] = (await exists(path)) ? await hashFile(path) : "missing";
  }
  return { ...hashes, ...(await loadCurrentOnlyHashes()) };
}

export async function resolveCurrentSource(relative: string): Promise<string | undefined> {
  return resolveSource(join(uiRoot, relative));
}
