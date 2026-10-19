/* eslint-disable max-lines */
/**
 * 裸包解析编排，在主线程中复用工作区文件服务和解析缓存。
 */
import { parentDirFromPath } from "@/files-workbench/filesMonacoTypescriptPath.js";
import {
  collectNodeBuiltinDeclaration,
  collectResolvedPackageFiles,
  extractImportSpecs,
  FilesResolutionCache,
  isNodeBuiltinSpecifier,
  loadNearestTsconfig,
  MAX_TYPES_NODE_FILES,
  normalizeNodeBuiltinSpecifier,
  resolveBareSpecifier,
  toTsCompilerOptions,
  typesNodeBuiltinDtsRel,
  type FilesResolutionIO,
  type ResolveCompilerOptionsInput,
  type ResolvedModuleFiles,
} from "@/files-workbench/filesMonacoTypescriptModuleResolve.js";
import type {
  FilesMonacoTypescriptResolveEntry,
  FilesMonacoTypescriptResolveLog,
  FilesMonacoTypescriptResolveOverrides,
  FilesMonacoTypescriptResolveResult,
} from "@/files-workbench/filesMonacoTypescriptResolveProtocol.js";

const cachesByWorkspace = new Map<string, FilesResolutionCache>();

export function getFilesResolutionCache(
  workspaceFolder: string,
  cacheScopeKey: string,
  io: FilesResolutionIO,
): FilesResolutionCache {
  const key = `${cacheScopeKey}\0${workspaceFolder.replace(/\/+$/, "") || "/"}`;
  let cache = cachesByWorkspace.get(key);
  if (!cache) {
    cache = new FilesResolutionCache(io);
    cachesByWorkspace.set(key, cache);
  } else {
    cache.setIO(io);
  }
  return cache;
}

export function clearTypescriptResolveCaches(cacheScopeKey?: string): void {
  for (const [key, cache] of cachesByWorkspace) {
    if (cacheScopeKey !== undefined && !key.startsWith(`${cacheScopeKey}\0`)) continue;
    cache.clear();
    cachesByWorkspace.delete(key);
  }
}

export function invalidateTypescriptResolveCachePath(cacheScopeKey: string, path?: string): void {
  if (!path) {
    clearTypescriptResolveCaches(cacheScopeKey);
    return;
  }
  for (const [key, cache] of cachesByWorkspace) {
    if (!key.startsWith(`${cacheScopeKey}\0`)) continue;
    cache.invalidatePath(path);
    cache.clearMissing();
  }
}

function fileNameFromAbsolutePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function isTsOrJsPath(path: string): boolean {
  const name = fileNameFromAbsolutePath(path).toLowerCase();
  return (
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".mts") ||
    name.endsWith(".cts") ||
    name.endsWith(".js") ||
    name.endsWith(".jsx") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs")
  );
}

function monacoOverridesFromNearest(
  workspaceFolder: string,
  nearest: Awaited<ReturnType<typeof loadNearestTsconfig>>,
): FilesMonacoTypescriptResolveOverrides {
  const configDirectory = nearest?.configDirectory ?? workspaceFolder;
  const compilerOptions = toTsCompilerOptions(nearest?.compilerOptions, configDirectory);
  const baseDir =
    typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : configDirectory;
  const overrides: FilesMonacoTypescriptResolveOverrides = {
    baseUrlPath: baseDir,
  };
  const options = nearest?.compilerOptions;
  if (options?.paths && typeof options.paths === "object") {
    const paths: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(options.paths)) {
      if (!Array.isArray(values)) continue;
      paths[key] = values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/^\.\//, ""));
    }
    if (Object.keys(paths).length > 0) {
      overrides.paths = paths;
    }
  }
  return overrides;
}

function relativeToBase(baseDir: string, absolutePath: string): string | undefined {
  const base = (baseDir.replace(/\/+$/, "") || "/").replace(/^\//, "");
  const abs = (absolutePath.replace(/\/+$/, "") || "/").replace(/^\//, "");
  if (!abs) return undefined;
  if (!base) return abs;

  const baseParts = base.split("/").filter(Boolean);
  const absParts = abs.split("/").filter(Boolean);
  let i = 0;
  while (i < baseParts.length && i < absParts.length && baseParts[i] === absParts[i]) {
    i += 1;
  }
  const up = baseParts.length - i;
  const down = absParts.slice(i);
  if (up === 0 && down.length === 0) return ".";
  return [...Array.from({ length: up }, () => ".."), ...down].join("/");
}

/** 把 specifier 映射到声明文件，供 Monaco Bundler 兜底（exports ambient 不齐时） */
function mergeSpecifierPaths(
  overrides: FilesMonacoTypescriptResolveOverrides,
  specifier: string,
  dtsAbsolutePath: string,
  logs: FilesMonacoTypescriptResolveLog[],
): void {
  const rel = relativeToBase(overrides.baseUrlPath, dtsAbsolutePath);
  if (!rel) {
    logs.push({
      level: "warn",
      message: `paths 跳过 ${specifier}：无法相对化到 baseUrl ${overrides.baseUrlPath}`,
    });
    return;
  }
  const paths = { ...overrides.paths };
  const keys = new Set<string>([specifier]);
  const builtin = normalizeNodeBuiltinSpecifier(specifier);
  if (builtin) {
    keys.add(builtin);
    keys.add(`node:${builtin}`);
  }
  for (const key of keys) {
    paths[key] = [rel];
  }
  overrides.paths = paths;
}

function matchesPathPattern(pattern: string, specifier: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix) &&
    specifier.length >= prefix.length + suffix.length
  );
}

/**
 * 对打开文件中的裸包 import 做 Node 式解析，返回待注入文件列表。
 */
export async function resolveBareModulesForEntriesCore(options: {
  workspaceFolder: string;
  entries: readonly FilesMonacoTypescriptResolveEntry[];
  maxPackageFilesTotal: number;
  maxPackageFilesPerResolve: number;
  io: FilesResolutionIO;
  cacheScopeKey?: string;
  clearMissing?: boolean;
  signal?: AbortSignal;
}): Promise<FilesMonacoTypescriptResolveResult> {
  const {
    workspaceFolder,
    entries,
    maxPackageFilesTotal,
    maxPackageFilesPerResolve,
    io,
    cacheScopeKey = workspaceFolder,
    clearMissing,
    signal,
  } = options;

  const root = workspaceFolder.replace(/\/+$/, "") || "/";
  const cache = getFilesResolutionCache(root, cacheScopeKey, io);
  if (clearMissing) cache.clearMissing();
  cache.resetMetrics();

  const startedAt = performance.now();
  let seedMs = 0;
  let resolveMs = 0;
  let collectMs = 0;

  const logs: FilesMonacoTypescriptResolveLog[] = [];
  logs.push({
    level: "info",
    message: `开始解析 workspace=${root} entries=${entries.length} clearMissing=${clearMissing === true}`,
  });

  const collected: ResolvedModuleFiles = new Map();
  const resolvedSpecs = new Set<string>();
  let sharedOptions = toTsCompilerOptions(undefined, root);
  let monacoOverrides: FilesMonacoTypescriptResolveOverrides | undefined;
  let nearestInput: ResolveCompilerOptionsInput | undefined;
  let configDirectory = root;
  let resolvedCount = 0;

  const entryList = entries.filter((entry) => isTsOrJsPath(entry.path));

  for (const entry of entryList) {
    if (signal?.aborted || collected.size >= maxPackageFilesTotal) break;

    const nearestStarted = performance.now();
    const nearest = await loadNearestTsconfig(entry.path, cache, signal);
    seedMs += performance.now() - nearestStarted;
    if (signal?.aborted) break;

    const configDir = nearest?.configDirectory ?? root;
    nearestInput = nearest?.compilerOptions;
    sharedOptions = toTsCompilerOptions(nearestInput, configDir);
    configDirectory = configDir;

    if (!monacoOverrides) {
      monacoOverrides = monacoOverridesFromNearest(root, nearest);
    }

    const { bare } = extractImportSpecs(entry.text);
    const aliasPatterns = Object.keys(nearest?.compilerOptions.paths ?? {});
    const specs = bare.filter((spec) => {
      if (aliasPatterns.some((pattern) => matchesPathPattern(pattern, spec))) return false;
      const cacheKey = `${parentDirFromPath(entry.path)}\0${spec}`;
      if (resolvedSpecs.has(cacheKey)) return false;
      resolvedSpecs.add(cacheKey);
      return true;
    });

    if (specs.length > 0) {
      logs.push({ level: "info", message: `${entry.path} 裸导入: ${specs.join(", ")}` });
    }

    const ordered = [
      ...specs.filter((s) => isNodeBuiltinSpecifier(s)),
      ...specs.filter((s) => !isNodeBuiltinSpecifier(s)),
    ];

    for (const spec of ordered) {
      if (signal?.aborted || collected.size >= maxPackageFilesTotal) break;

      if (isNodeBuiltinSpecifier(spec)) {
        const before = collected.size;
        const collectStarted = performance.now();
        const dtsPath = await collectNodeBuiltinDeclaration(
          cache,
          entry.path,
          spec,
          collected,
          signal,
          Math.min(MAX_TYPES_NODE_FILES, maxPackageFilesTotal - collected.size),
        );
        collectMs += performance.now() - collectStarted;
        if (dtsPath) {
          resolvedCount += 1;
          mergeSpecifierPaths(monacoOverrides, spec, dtsPath, logs);
          logs.push({ level: "info", message: `✓ ${spec} → ${dtsPath}` });
        } else if (collected.size > before) {
          resolvedCount += 1;
          const builtin = normalizeNodeBuiltinSpecifier(spec);
          if (builtin) {
            for (const path of collected.keys()) {
              if (path.endsWith(`/${typesNodeBuiltinDtsRel(builtin)}`)) {
                mergeSpecifierPaths(monacoOverrides, spec, path, logs);
                break;
              }
            }
          }
          logs.push({ level: "warn", message: `✓ ${spec}（部分收集）` });
        } else {
          logs.push({ level: "error", message: `✗ ${spec} 未找到 @types/node` });
        }
        continue;
      }

      const resolveStarted = performance.now();
      const resolved = await resolveBareSpecifier(cache, entry.path, spec, sharedOptions, signal);
      resolveMs += performance.now() - resolveStarted;
      if (!resolved) {
        logs.push({ level: "error", message: `✗ ${spec} 解析失败` });
        continue;
      }
      resolvedCount += 1;
      mergeSpecifierPaths(monacoOverrides, spec, resolved, logs);
      logs.push({ level: "info", message: `✓ ${spec} → ${resolved}` });

      const perResolveMax = resolved.includes("/node_modules/@types/node/")
        ? Math.min(MAX_TYPES_NODE_FILES, maxPackageFilesTotal - collected.size)
        : Math.min(maxPackageFilesPerResolve, maxPackageFilesTotal - collected.size);

      const before = collected.size;
      const collectStarted = performance.now();
      await collectResolvedPackageFiles(
        cache,
        resolved,
        collected,
        signal,
        perResolveMax,
        sharedOptions,
        entry.path,
      );
      collectMs += performance.now() - collectStarted;
      logs.push({
        level: "info",
        message: `收集 ${spec}: +${collected.size - before} 文件（合计 ${collected.size}）`,
      });
    }
  }

  if (!monacoOverrides) {
    monacoOverrides = { baseUrlPath: root };
  }

  const metrics = cache.getMetrics();
  const totalMs = Math.round(performance.now() - startedAt);
  logs.push({
    level: resolvedCount > 0 ? "info" : "warn",
    message: `完成: resolved=${resolvedCount} files=${collected.size} paths=${Object.keys(monacoOverrides.paths ?? {}).length} totalMs=${totalMs} seedMs=${Math.round(seedMs)} resolveMs=${Math.round(resolveMs)} collectMs=${Math.round(collectMs)} probeCount=${metrics.probeCount} readCount=${metrics.readCount} pnpmListCount=${metrics.pnpmListCount}`,
  });

  return {
    files: [...collected.entries()].map(([path, content]) => ({ path, content })),
    monacoOverrides,
    nearestCompilerOptions: nearestInput,
    configDirectory,
    resolvedCount,
    logs,
  };
}
