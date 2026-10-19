/* eslint-disable max-lines */
import type * as Monaco from "monaco-editor";
import type { IServiceAccessor } from "@zcode/services";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";
import { createFilesMonacoTypescriptResolverIO } from "@/files-workbench/filesMonacoTypescriptResolverIO.js";
import {
  applyFilesMonacoTypescriptCompilerOverrides,
  setFilesMonacoTypescriptExtraLibs,
} from "@/files-workbench/filesMonacoTypescriptCompiler.js";
import {
  extractImportSpecs,
  loadNearestTsconfig,
  toTsCompilerOptions,
  type FilesResolutionIO,
  type FilesResolutionCache,
} from "@/files-workbench/filesMonacoTypescriptModuleResolve.js";
import {
  clearTypescriptResolveCaches,
  getFilesResolutionCache,
  invalidateTypescriptResolveCachePath,
  resolveBareModulesForEntriesCore,
} from "@/files-workbench/filesMonacoTypescriptResolveCore.js";
import {
  filesMonacoTypescriptWorkspaceScope,
  filesMonacoVirtualPath,
  joinFilesAbsolutePath,
  normalizeFilesMonacoPath,
  parentDirFromPath,
} from "@/files-workbench/filesMonacoTypescriptPath.js";

const MAX_LOCAL_MODULE_FILES = 80;
const MAX_LOCAL_MODULE_DEPTH = 8;
const MAX_PACKAGE_FILES_TOTAL = 500;
const MAX_PACKAGE_FILES_PER_RESOLVE = 40;
const MAX_TOTAL_EXTRA_LIBS = 1_200;
const MAX_WORKSPACE_SYNC_DURATION_MS = 12_000;

export interface FilesMonacoTypescriptWorkspaceEntry {
  bufferId: string;
  path: string;
  text: string;
  workspace: FilesWorkspaceRef;
}

interface WorkspaceBucket {
  scope: string;
  workspace: FilesWorkspaceRef;
  entries: FilesMonacoTypescriptWorkspaceEntry[];
}

interface WorkspaceSyncResult {
  scope: string;
  workspace: FilesWorkspaceRef;
  localFiles: Map<string, string>;
  packageFiles: Map<string, string>;
  baseUrlPath: string;
  paths?: Record<string, string[]>;
}

type ResolveServices = (workspace: FilesWorkspaceRef) => IServiceAccessor;

const localFilesByScope = new Map<string, Map<string, string>>();
const packageFilesByScope = new Map<string, Map<string, string>>();
const compilerOverridesByScope = new Map<
  string,
  { baseUrlPath: string; paths?: Record<string, string[]> }
>();
const bareImportKeysByScope = new Map<string, string>();
const knownScopes = new Set<string>();
let syncGeneration = 0;
let activeAbortController: AbortController | undefined;
let inFlightSync: Promise<void> | undefined;

function isTypescriptOrJavascriptPath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(path);
}

function isPathAlias(patterns: readonly string[], specifier: string): boolean {
  return patterns.some((pattern) => {
    const star = pattern.indexOf("*");
    if (star < 0) return pattern === specifier;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    return (
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length
    );
  });
}

function resolveRelativePath(fromDir: string, specifier: string): string {
  return joinFilesAbsolutePath(fromDir, specifier);
}

function substitutePathPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function modulePathCandidates(base: string): string[] {
  const normalized = normalizeFilesMonacoPath(base);
  const candidates = new Set<string>();
  const add = (path: string) => candidates.add(normalizeFilesMonacoPath(path));
  const ext = normalized.match(/\.(d\.)?(mts|cts|tsx?|jsx?|mjs|cjs|json)$/i)?.[0]?.toLowerCase();
  if (ext === ".js" || ext === ".jsx") {
    const stem = normalized.slice(0, -ext.length);
    for (const suffix of [".ts", ".tsx", ".d.ts", ".js", ".jsx"]) add(`${stem}${suffix}`);
  } else if (ext === ".mjs") {
    const stem = normalized.slice(0, -ext.length);
    for (const suffix of [".mts", ".d.mts", ".mjs"]) add(`${stem}${suffix}`);
  } else if (ext === ".cjs") {
    const stem = normalized.slice(0, -ext.length);
    for (const suffix of [".cts", ".d.cts", ".cjs"]) add(`${stem}${suffix}`);
  } else if (!ext) {
    for (const suffix of [
      ".ts",
      ".tsx",
      ".d.ts",
      ".mts",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".json",
      "/index.ts",
      "/index.tsx",
      "/index.d.ts",
      "/index.mts",
      "/index.cts",
      "/index.js",
      "/index.jsx",
      "/index.json",
    ])
      add(`${normalized}${suffix}`);
  } else {
    add(normalized);
  }
  return [...candidates];
}

async function findExistingModulePath(
  cache: FilesResolutionCache,
  fromPath: string,
  specifier: string,
  nearestConfig: Awaited<ReturnType<typeof loadNearestTsconfig>>,
  signal: AbortSignal,
): Promise<string | undefined> {
  const candidates = new Set<string>();
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/")
      ? normalizeFilesMonacoPath(specifier)
      : resolveRelativePath(parentDirFromPath(fromPath), specifier);
    for (const candidate of modulePathCandidates(base)) candidates.add(candidate);
  } else {
    const paths = nearestConfig?.compilerOptions.paths;
    if (!paths || !nearestConfig) return undefined;
    const baseUrl = toTsCompilerOptions(
      nearestConfig.compilerOptions,
      nearestConfig.configDirectory,
    ).baseUrl;
    const baseDirectory = typeof baseUrl === "string" ? baseUrl : nearestConfig.configDirectory;
    for (const [pattern, targets] of Object.entries(paths)) {
      const wildcard = substitutePathPattern(pattern, specifier);
      if (wildcard === undefined) continue;
      for (const target of targets) {
        const substituted = target.includes("*") ? target.replace("*", wildcard) : target;
        const base = substituted.startsWith("/")
          ? normalizeFilesMonacoPath(substituted)
          : joinFilesAbsolutePath(baseDirectory, substituted);
        for (const candidate of modulePathCandidates(base)) candidates.add(candidate);
      }
    }
  }
  if (candidates.size === 0) return undefined;
  for (const candidate of candidates) cache.fileExists(candidate);
  await cache.flushPending(signal);
  if (signal.aborted) return undefined;
  return [...candidates].find((candidate) => cache.fileExists(candidate));
}

async function resolveLocalModules(
  entries: readonly FilesMonacoTypescriptWorkspaceEntry[],
  cache: FilesResolutionCache,
  signal: AbortSignal,
  activeBufferId?: string,
): Promise<{ files: Map<string, string>; unresolved: boolean }> {
  const sources = entries
    .filter((entry) => isTypescriptOrJavascriptPath(entry.path))
    .sort(
      (left, right) =>
        Number(right.bufferId === activeBufferId) - Number(left.bufferId === activeBufferId),
    )
    .slice(0, MAX_LOCAL_MODULE_FILES);
  const queue = sources.map((entry) => ({
    path: normalizeFilesMonacoPath(entry.path),
    text: entry.text,
    depth: 0,
  }));
  const visited = new Set(queue.map((entry) => entry.path));
  const resolved = new Map<string, string>();
  let unresolved = false;
  const configCache = new Map<string, Awaited<ReturnType<typeof loadNearestTsconfig>>>();

  let processedFiles = 0;
  while (
    queue.length > 0 &&
    processedFiles < MAX_LOCAL_MODULE_FILES &&
    resolved.size < MAX_LOCAL_MODULE_FILES
  ) {
    if (signal.aborted) break;
    const current = queue.shift();
    processedFiles += 1;
    if (!current || current.depth >= MAX_LOCAL_MODULE_DEPTH) continue;
    const { relative, bare } = extractImportSpecs(current.text);
    const nearestConfigKey = parentDirFromPath(current.path);
    let nearestConfig = configCache.get(nearestConfigKey);
    if (nearestConfig === undefined && !configCache.has(nearestConfigKey)) {
      nearestConfig = await loadNearestTsconfig(current.path, cache, signal);
      configCache.set(nearestConfigKey, nearestConfig);
    }
    const aliases = Object.keys(nearestConfig?.compilerOptions.paths ?? {});
    const specs = [...relative, ...bare.filter((specifier) => isPathAlias(aliases, specifier))];

    for (const specifier of specs) {
      if (signal.aborted || resolved.size >= MAX_LOCAL_MODULE_FILES) break;
      const path = await findExistingModulePath(
        cache,
        current.path,
        specifier,
        nearestConfig,
        signal,
      );
      if (!path) continue;
      if (visited.has(path)) continue;
      visited.add(path);
      const text = await cache.ensureFileContent(path, signal);
      if (text === undefined) {
        unresolved = true;
        continue;
      }
      resolved.set(path, text);
      if (isTypescriptOrJavascriptPath(path)) {
        queue.push({ path, text, depth: current.depth + 1 });
      }
    }
  }
  return { files: resolved, unresolved };
}

function hashKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function makeBareImportKey(entries: readonly FilesMonacoTypescriptWorkspaceEntry[]): string {
  return hashKey(
    entries
      .filter((entry) => isTypescriptOrJavascriptPath(entry.path))
      .map((entry) => {
        const { bare } = extractImportSpecs(entry.text);
        return `${entry.path}\0${bare.sort().join("\0")}`;
      })
      .sort()
      .join("\n"),
  );
}

function groupWorkspaceEntries(
  entries: readonly FilesMonacoTypescriptWorkspaceEntry[],
): Map<string, WorkspaceBucket> {
  const groups = new Map<string, WorkspaceBucket>();
  for (const entry of entries) {
    const scope = filesMonacoTypescriptWorkspaceScope(entry.workspace);
    let group = groups.get(scope);
    if (!group) {
      group = { scope, workspace: entry.workspace, entries: [] };
      groups.set(scope, group);
    }
    group.entries.push(entry);
  }
  return groups;
}

async function syncWorkspaceBucket(
  bucket: WorkspaceBucket,
  resolveServices: ResolveServices,
  signal: AbortSignal,
  activeBufferId?: string,
): Promise<WorkspaceSyncResult | undefined> {
  knownScopes.add(bucket.scope);
  const workspaceFolder = normalizeFilesMonacoPath(bucket.workspace.workspacePath);
  const io: FilesResolutionIO = createFilesMonacoTypescriptResolverIO(
    resolveServices(bucket.workspace),
  );
  const rootStat = await io.stat(workspaceFolder);
  if (!rootStat || rootStat.kind !== "folder") {
    throw new Error("typescript-resolver-workspace-unavailable");
  }
  const cache = getFilesResolutionCache(workspaceFolder, bucket.scope, io);
  for (const entry of bucket.entries) cache.seedFile(entry.path, entry.text);

  const entriesForResolution = bucket.entries
    .filter((entry) => isTypescriptOrJavascriptPath(entry.path))
    .sort(
      (left, right) =>
        Number(right.bufferId === activeBufferId) - Number(left.bufferId === activeBufferId),
    )
    .slice(0, MAX_LOCAL_MODULE_FILES)
    .map((entry) => ({ path: entry.path, text: entry.text }));
  const bareKey = makeBareImportKey(
    bucket.entries
      .filter((entry) => isTypescriptOrJavascriptPath(entry.path))
      .sort(
        (left, right) =>
          Number(right.bufferId === activeBufferId) - Number(left.bufferId === activeBufferId),
      )
      .slice(0, MAX_LOCAL_MODULE_FILES),
  );
  const clearMissing = bareImportKeysByScope.get(bucket.scope) !== bareKey;
  bareImportKeysByScope.set(bucket.scope, bareKey);

  const packageResult = await resolveBareModulesForEntriesCore({
    workspaceFolder,
    entries: entriesForResolution,
    maxPackageFilesTotal: MAX_PACKAGE_FILES_TOTAL,
    maxPackageFilesPerResolve: MAX_PACKAGE_FILES_PER_RESOLVE,
    cacheScopeKey: bucket.scope,
    io,
    clearMissing,
    signal,
  });
  if (signal.aborted) return undefined;

  const localResult = await resolveLocalModules(bucket.entries, cache, signal, activeBufferId);
  if (signal.aborted) return undefined;

  const currentPackageFiles = new Map(packageResult.files.map((file) => [file.path, file.content]));
  const packageSpecs = new Set<string>();
  const nearestConfigs = await Promise.all(
    entriesForResolution.map((entry) => loadNearestTsconfig(entry.path, cache, signal)),
  );
  const aliasPatterns = [
    ...new Set(
      nearestConfigs.flatMap((config) => Object.keys(config?.compilerOptions.paths ?? {})),
    ),
  ];
  for (const entry of entriesForResolution) {
    const { bare } = extractImportSpecs(entry.text);
    for (const specifier of bare) {
      if (!isPathAlias(aliasPatterns, specifier)) packageSpecs.add(specifier);
    }
  }
  const previousPackageFiles = packageFilesByScope.get(bucket.scope) ?? new Map<string, string>();
  let packageFiles: Map<string, string>;
  if (packageSpecs.size === 0 || (packageResult.resolvedCount ?? 0) >= packageSpecs.size) {
    packageFiles = currentPackageFiles;
  } else {
    packageFiles = new Map(previousPackageFiles);
    for (const [path, content] of currentPackageFiles) packageFiles.set(path, content);
  }

  const previousLocalFiles = localFilesByScope.get(bucket.scope) ?? new Map<string, string>();
  const nextLocalFiles = localResult.unresolved
    ? new Map([...previousLocalFiles, ...localResult.files])
    : localResult.files;
  localFilesByScope.set(bucket.scope, nextLocalFiles);
  packageFilesByScope.set(bucket.scope, packageFiles);

  const overrides = packageResult.monacoOverrides ?? { baseUrlPath: workspaceFolder };
  compilerOverridesByScope.set(bucket.scope, overrides);
  return {
    scope: bucket.scope,
    workspace: bucket.workspace,
    localFiles: nextLocalFiles,
    packageFiles,
    baseUrlPath: overrides.baseUrlPath,
    paths: overrides.paths,
  };
}

function flattenExtraLibs(
  monaco: typeof Monaco,
  orderedResults: readonly WorkspaceSyncResult[],
  buckets: ReadonlyMap<string, WorkspaceBucket>,
): Array<{ workspace: FilesWorkspaceRef; path: string; content: string }> {
  const libs: Array<{ workspace: FilesWorkspaceRef; path: string; content: string }> = [];
  const seen = new Set<string>();
  for (const result of orderedResults) {
    const openedPaths = new Set(
      (buckets.get(result.scope)?.entries ?? []).map((entry) =>
        normalizeFilesMonacoPath(entry.path),
      ),
    );
    for (const files of [result.localFiles, result.packageFiles]) {
      for (const [path, content] of files) {
        const normalized = normalizeFilesMonacoPath(path);
        if (openedPaths.has(normalized)) continue;
        const virtualPath = filesMonacoVirtualPath(result.workspace, normalized);
        const uri = monaco.Uri.file(virtualPath).toString();
        if (seen.has(uri)) continue;
        seen.add(uri);
        libs.push({ workspace: result.workspace, path: normalized, content });
        if (libs.length >= MAX_TOTAL_EXTRA_LIBS) return libs;
      }
    }
  }
  return libs;
}

/** Sync project sources/types into Monaco without changing the existing file buffer or save model. */
export async function syncFilesMonacoTypescriptWorkspace(options: {
  monaco: typeof Monaco;
  entries: readonly FilesMonacoTypescriptWorkspaceEntry[];
  activeWorkspace?: FilesWorkspaceRef;
  activeBufferId?: string;
  resolveServices: ResolveServices;
  /** Primarily for deterministic timeout tests; production defaults to 12 seconds. */
  maxDurationMs?: number;
}): Promise<void> {
  const generation = ++syncGeneration;
  activeAbortController?.abort();
  const controller = new AbortController();
  activeAbortController = controller;
  const previous = inFlightSync;
  const run = (async () => {
    if (previous) await previous.catch(() => undefined);
    if (controller.signal.aborted || generation !== syncGeneration) return;

    const buckets = groupWorkspaceEntries(options.entries);
    const activeScope = options.activeWorkspace
      ? filesMonacoTypescriptWorkspaceScope(options.activeWorkspace)
      : undefined;
    const orderedBuckets = [...buckets.values()].sort((left, right) => {
      if (left.scope === activeScope) return -1;
      if (right.scope === activeScope) return 1;
      return 0;
    });
    const results: WorkspaceSyncResult[] = [];
    for (const bucket of orderedBuckets) {
      if (controller.signal.aborted || generation !== syncGeneration) return;
      try {
        const result = await syncWorkspaceBucket(
          bucket,
          options.resolveServices,
          controller.signal,
          options.activeBufferId,
        );
        if (result) results.push(result);
      } catch {
        // Preserve this workspace's last valid cache if the file service disconnects or resolution fails.
      }
    }
    if (controller.signal.aborted || generation !== syncGeneration) return;

    for (const scope of knownScopes) {
      if (buckets.has(scope)) continue;
      knownScopes.delete(scope);
      localFilesByScope.delete(scope);
      packageFilesByScope.delete(scope);
      compilerOverridesByScope.delete(scope);
      bareImportKeysByScope.delete(scope);
      clearTypescriptResolveCaches(scope);
    }

    for (const bucket of orderedBuckets) {
      if (results.some((result) => result.scope === bucket.scope)) continue;
      const localFiles = localFilesByScope.get(bucket.scope);
      const packageFiles = packageFilesByScope.get(bucket.scope);
      const overrides = compilerOverridesByScope.get(bucket.scope);
      if (!localFiles && !packageFiles && !overrides) continue;
      results.push({
        scope: bucket.scope,
        workspace: bucket.workspace,
        localFiles: localFiles ?? new Map(),
        packageFiles: packageFiles ?? new Map(),
        baseUrlPath: overrides?.baseUrlPath ?? bucket.workspace.workspacePath,
        paths: overrides?.paths,
      });
    }

    const activeOverrides = activeScope ? compilerOverridesByScope.get(activeScope) : undefined;
    applyFilesMonacoTypescriptCompilerOverrides(
      options.monaco,
      options.activeWorkspace,
      activeOverrides,
    );
    const orderedResults = [
      ...results.filter((result) => result.scope === activeScope),
      ...results.filter((result) => result.scope !== activeScope),
    ];
    setFilesMonacoTypescriptExtraLibs(
      options.monaco,
      flattenExtraLibs(options.monaco, orderedResults, buckets),
    );
  })();
  let abortWaiter: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    abortWaiter = () => resolve();
    controller.signal.addEventListener("abort", abortWaiter, { once: true });
  });
  const boundedRun = Promise.race([run, aborted]);
  inFlightSync = boundedRun;
  const maxDurationMs = Math.max(
    10,
    Math.min(30_000, options.maxDurationMs ?? MAX_WORKSPACE_SYNC_DURATION_MS),
  );
  const timeout = setTimeout(() => controller.abort(), maxDurationMs);
  try {
    await boundedRun;
  } finally {
    clearTimeout(timeout);
    if (abortWaiter) controller.signal.removeEventListener("abort", abortWaiter);
    if (inFlightSync === boundedRun) inFlightSync = undefined;
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

export function cancelFilesMonacoTypescriptSync(): void {
  syncGeneration += 1;
  activeAbortController?.abort();
  activeAbortController = undefined;
}

export function invalidateFilesMonacoTypescriptWorkspaceCache(
  scope: string,
  changedPath?: string,
): void {
  invalidateTypescriptResolveCachePath(scope, changedPath);
}
