// 文件树 / 搜索索引的连接恢复集成测试。本包没有 DOM 渲染环境，沿用
// filesSaveAsNativeDialogHook 的最小 React hook 运行时，编译真实源码并驱动
// render、effect、promise 续接，验证断线不是永久目录错误、恢复后自动重读。
//
// 产品规则见 docs/specs/workspace-files.md「连接中断与恢复」。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { SERVICE_ACCESSOR_CONNECTION } from "@zcode/shared";
import {
  packWorkspaceFileEntries,
  unpackWorkspaceFileEntries,
} from "@zcode/shared/workspaceFileEntriesCodec";
import * as constantsModule from "../src/workspace-file-tree/constants.js";
import * as helpersModule from "../src/workspace-file-tree/helpers.js";
import * as modelModule from "../src/workspace-file-tree/model.js";
import * as refreshDirectoriesModule from "../src/workspace-file-tree/refreshDirectories.js";
import * as searchModelModule from "../src/workspace-file-tree/workspaceFileTreeSearchModel.js";
import * as pathMatchModule from "../src/workspace-file-tree/workspaceFilePathMatch.js";

const WORKSPACE_PATH = "C:\\work";
const ROOT_PATH = "C:\\work";

const dataSource = await readFile(
  new URL("../src/workspace-file-tree/useWorkspaceFileTreeData.ts", import.meta.url),
  "utf8",
);
const searchSource = await readFile(
  new URL("../src/workspace-file-tree/useWorkspaceFileSearchIndex.ts", import.meta.url),
  "utf8",
);
const rowsSource = await readFile(
  new URL("../src/workspace-file-tree/useWorkspaceFileTreeRows.ts", import.meta.url),
  "utf8",
);
const recoverySource = await readFile(
  new URL("../src/workspace-file-tree/useWorkspaceFileTreeConnectionRecovery.ts", import.meta.url),
  "utf8",
);

function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "react",
      esModuleInterop: true,
    },
  }).outputText;
}

const dataOutput = transpile(dataSource);
const searchOutput = transpile(searchSource);
const rowsOutput = transpile(rowsSource);
const recoveryOutput = transpile(recoverySource);

function dependenciesEqual(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return (
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]))
  );
}

interface StateSlot {
  kind: "state";
  value: unknown;
  set: (next: unknown) => void;
}

interface RefSlot {
  kind: "ref";
  current: unknown;
}

interface MemoSlot {
  kind: "memo";
  value: unknown;
  deps?: readonly unknown[];
}

interface CallbackSlot {
  kind: "callback";
  callback: unknown;
  deps?: readonly unknown[];
}

interface EffectSlot {
  kind: "effect";
  next?: { run: () => void | (() => void); deps?: readonly unknown[] };
  deps?: readonly unknown[];
  cleanup?: () => void;
  mounted: boolean;
}

type Slot = StateSlot | RefSlot | MemoSlot | CallbackSlot | EffectSlot;

/** 最小 React hook 运行时：state 写入触发同步重渲染，effect 按依赖执行。 */
function createHookRuntime() {
  const slots: Slot[] = [];
  let cursor = 0;
  let rendering = false;
  let renderQueued = false;
  let unmounted = false;
  let renderImplementation: () => unknown = () => null;
  let result: unknown;

  const scheduleRender = () => {
    if (unmounted) return;
    if (rendering) {
      renderQueued = true;
      return;
    }
    render();
  };

  const useState = <T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] => {
    const index = cursor++;
    let slot = slots[index] as StateSlot | undefined;
    if (!slot) {
      const stateSlot: StateSlot = {
        kind: "state",
        value: typeof initial === "function" ? (initial as () => T)() : initial,
        set: () => undefined,
      };
      stateSlot.set = (next) => {
        if (unmounted) return;
        const resolved =
          typeof next === "function"
            ? (next as (previous: unknown) => unknown)(stateSlot.value)
            : next;
        if (Object.is(resolved, stateSlot.value)) return;
        stateSlot.value = resolved;
        scheduleRender();
      };
      slot = stateSlot;
      slots[index] = slot;
    }
    return [slot.value as T, slot.set as (next: T | ((previous: T) => T)) => void];
  };

  const useRef = <T>(initial: T): { current: T } => {
    const index = cursor++;
    let slot = slots[index] as RefSlot | undefined;
    if (!slot) {
      slot = { kind: "ref", current: initial };
      slots[index] = slot;
    }
    return slot as { current: T };
  };

  const useMemo = <T>(factory: () => T, deps?: readonly unknown[]): T => {
    const index = cursor++;
    let slot = slots[index] as MemoSlot | undefined;
    if (
      !slot ||
      deps === undefined ||
      slot.deps === undefined ||
      !dependenciesEqual(slot.deps, deps)
    ) {
      slot = { kind: "memo", value: factory(), deps };
      slots[index] = slot;
    }
    return slot.value as T;
  };

  const useCallback = <T extends (...args: never[]) => unknown>(
    callback: T,
    deps?: readonly unknown[],
  ): T => {
    const index = cursor++;
    let slot = slots[index] as CallbackSlot | undefined;
    if (
      !slot ||
      deps === undefined ||
      slot.deps === undefined ||
      !dependenciesEqual(slot.deps, deps)
    ) {
      slot = { kind: "callback", callback, deps };
      slots[index] = slot;
    }
    return slot.callback as T;
  };

  const useEffect = (run: () => void | (() => void), deps?: readonly unknown[]): void => {
    const index = cursor++;
    let slot = slots[index] as EffectSlot | undefined;
    if (!slot) {
      slot = { kind: "effect", mounted: false };
      slots[index] = slot;
    }
    slot.next = { run, deps };
  };

  const flushEffects = () => {
    for (const slot of slots) {
      if (slot.kind !== "effect" || !slot.next) continue;
      const next = slot.next;
      slot.next = undefined;
      const changed =
        !slot.mounted ||
        next.deps === undefined ||
        slot.deps === undefined ||
        !dependenciesEqual(slot.deps, next.deps);
      if (!changed) continue;
      slot.cleanup?.();
      slot.mounted = true;
      slot.deps = next.deps;
      const cleanup = next.run();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  };

  const render = () => {
    if (unmounted) return;
    rendering = true;
    try {
      do {
        renderQueued = false;
        cursor = 0;
        for (const slot of slots) {
          if (slot.kind === "effect") slot.next = undefined;
        }
        result = renderImplementation();
        flushEffects();
      } while (renderQueued);
    } finally {
      rendering = false;
    }
  };

  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    for (const slot of slots) {
      if (slot.kind === "effect" && slot.mounted) {
        slot.cleanup?.();
        slot.mounted = false;
        slot.cleanup = undefined;
      }
    }
  };

  return {
    react: { useState, useRef, useMemo, useCallback, useEffect },
    setRender(implementation: () => unknown) {
      renderImplementation = implementation;
    },
    render,
    unmount,
    get result() {
      return result;
    },
  };
}

function loadCommonJs(
  output: string,
  resolveModule: (id: string) => unknown,
): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", "module", output)(resolveModule, exports, { exports });
  return exports;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function connectionClosedError(): Error {
  const error = new Error("WebSocket service generation 2 is not connected");
  error.name = "ConnectionClosed";
  return error;
}

interface ReadDirCall {
  path: string;
  resolve: (entries: unknown[]) => void;
  reject: (error: unknown) => void;
}

function createFileService(options: { withConnectionPort: boolean }) {
  const calls: ReadDirCall[] = [];
  const listeners = new Set<() => void>();
  let attachment: object | null = { attachment: 1 };
  const fileService: Record<string | symbol, unknown> = {
    readdir({ path }: { path: string }): Promise<unknown[]> {
      const deferred = createDeferred<unknown[]>();
      calls.push({ path, resolve: deferred.resolve, reject: deferred.reject });
      return deferred.promise;
    },
  };
  if (options.withConnectionPort) {
    fileService[SERVICE_ACCESSOR_CONNECTION] = {
      getAttachment: () => attachment,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }
  return {
    fileService,
    calls,
    attach(next?: object) {
      attachment = next ?? { attachment: Date.now() };
      for (const listener of listeners) listener();
    },
  };
}

interface DataResult {
  rows: Array<{ name: string; path: string }>;
  errorByDirectory: Map<string, Error>;
  loadedDirectoryPaths: Set<string>;
  loadingDirectoryPaths: Set<string>;
  refreshLoadedDirectories: () => Promise<void>;
  loadDirectory: (
    path: string,
    depth: number,
    options?: { force?: boolean },
  ) => Promise<"loaded" | "stale" | "failed" | "transportInterrupted">;
  recovery: unknown;
}

interface SearchResult {
  entries: Array<{ name: string; path: string }>;
  loading: boolean;
  loaded: boolean;
  error: Error | null;
}

interface HarnessParams {
  rpcReady: boolean;
  enabled: boolean;
  withConnectionPort: boolean;
  workspacePath?: string;
  workspaceIdentity?: string;
  services?: {
    fileService: Record<string | symbol, unknown>;
    fileWatcherService: object;
    gitService: object;
  };
}

interface SearchCall {
  fileService: unknown;
  rootPath: string;
  options: Record<string, unknown>;
  resolve: (packed: string) => void;
  reject: (error: unknown) => void;
}

function createHarness(initial: HarnessParams) {
  const runtime = createHookRuntime();
  const fileService = createFileService({ withConnectionPort: initial.withConnectionPort });
  const searchCalls: SearchCall[] = [];
  let services = initial.services ?? {
    fileService: fileService.fileService,
    fileWatcherService: {},
    gitService: {},
  };
  const resolution = {
    services,
    rpcReady: initial.rpcReady,
  };

  const sharedModule = {
    getServiceAccessorConnection: (service: object) =>
      (service as Record<string | symbol, unknown>)[SERVICE_ACCESSOR_CONNECTION],
  };
  const recoveryModule = loadCommonJs(recoveryOutput, (id) => {
    switch (id) {
      case "react":
        return runtime.react;
      case "@zcode/shared":
        return sharedModule;
      default:
        throw new Error(`未预期的恢复门依赖 ${id}`);
    }
  });
  const rowsModule = loadCommonJs(rowsOutput, (id) => {
    switch (id) {
      case "react":
        return runtime.react;
      case "@/workspace-file-tree/model.js":
        return modelModule;
      default:
        throw new Error(`未预期的行依赖 ${id}`);
    }
  });
  const servicesModule = {
    useWorkspaceServicesResolution: () => resolution,
    useWorkspaceServices: () => resolution.services,
  };
  const dataModule = loadCommonJs(dataOutput, (id) => {
    switch (id) {
      case "react":
        return runtime.react;
      case "@/hooks/useWorkspaceServices.js":
        return servicesModule;
      case "@/logger.js":
        return {
          logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
        };
      case "@/workspace-file-tree/constants.js":
        return constantsModule;
      case "@/workspace-file-tree/helpers.js":
        return helpersModule;
      case "@/workspace-file-tree/model.js":
        return modelModule;
      case "@/workspace-file-tree/gitStatus.js":
        return {
          loadWorkspaceFileTreeGitStatus: async () => ({
            available: false,
            statusByPath: new Map(),
          }),
        };
      case "@/workspace-file-tree/useWorkspaceFileTreeConnectionRecovery.js":
        return recoveryModule;
      case "@/workspace-file-tree/useWorkspaceFileTreeWatchers.js":
        return { useWorkspaceFileTreeWatchers: () => undefined };
      case "@/workspace-file-tree/refreshDirectories.js":
        return refreshDirectoriesModule;
      case "@/workspace-file-tree/useWorkspaceFileTreeRows.js":
        return rowsModule;
      default:
        throw new Error(`未预期的数据 hook 依赖 ${id}`);
    }
  });
  const searchModule = loadCommonJs(searchOutput, (id) => {
    switch (id) {
      case "react":
        return runtime.react;
      case "@zcode/shared/workspaceFileEntriesCodec":
        return { packWorkspaceFileEntries, unpackWorkspaceFileEntries };
      case "@/hooks/useWorkspaceServices.js":
        return servicesModule;
      case "@/workspace-file-search/fetchWorkspaceFileEntries.js":
        return {
          fetchWorkspaceFileEntriesPacked: (
            service: unknown,
            rootPath: string,
            options: Record<string, unknown>,
          ) => {
            const deferred = createDeferred<string>();
            searchCalls.push({
              fileService: service,
              rootPath,
              options,
              resolve: deferred.resolve,
              reject: deferred.reject,
            });
            return deferred.promise;
          },
        };
      case "@/workspace-file-search/useWorkspaceFileSearchFilter.js":
        return {
          useWorkspaceFileSearchFilterEntries: () => ({ items: [], filtering: false }),
        };
      case "@/workspace-file-tree/workspaceFilePathMatch.js":
        return pathMatchModule;
      case "@/workspace-file-tree/workspaceFileTreeSearchModel.js":
        return searchModelModule;
      default:
        throw new Error(`未预期的搜索 hook 依赖 ${id}`);
    }
  });

  let params = initial;
  let captured!: { tree: DataResult; search: SearchResult };
  runtime.setRender(() => {
    resolution.rpcReady = params.rpcReady;
    resolution.services = services;
    const workspacePath = params.workspacePath ?? WORKSPACE_PATH;
    const tree = (
      dataModule.useWorkspaceFileTreeData as (value: {
        workspacePath: string;
        workspaceIdentity?: string;
        enableWorkspaceFeatures: boolean;
      }) => DataResult
    )({
      workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      enableWorkspaceFeatures: false,
    });
    const search = (
      searchModule.useWorkspaceFileSearchIndex as (value: {
        workspacePath: string;
        workspaceIdentity?: string;
        enabled: boolean;
        recovery: unknown;
      }) => SearchResult
    )({
      workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      enabled: params.enabled,
      recovery: tree.recovery,
    });
    captured = { tree, search };
    return captured;
  });
  runtime.render();

  return {
    get tree() {
      return captured.tree;
    },
    get search() {
      return captured.search;
    },
    get fileService() {
      return fileService;
    },
    get searchCalls() {
      return searchCalls;
    },
    rerender(patch: Partial<HarnessParams>) {
      params = { ...params, ...patch };
      if (patch.services) {
        services = patch.services;
      }
      resolution.rpcReady = params.rpcReady;
      runtime.render();
    },
    /** 切换到另一个 workspace 目标：新的路径 / 身份 / resolved services。 */
    switchWorkspace(next: {
      workspacePath: string;
      workspaceIdentity?: string;
      services: HarnessParams["services"];
    }) {
      params = {
        ...params,
        workspacePath: next.workspacePath,
        workspaceIdentity: next.workspaceIdentity,
        services: next.services,
      };
      services = next.services ?? services;
      runtime.render();
    },
    unmount: runtime.unmount,
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fileEntry(name: string) {
  return {
    name,
    path: `${ROOT_PATH}\\${name}`,
    relativePath: name,
    type: "file" as const,
  };
}

function packedEntries(names: string[]): string {
  return packWorkspaceFileEntries(
    names.map((name) => ({ type: "file" as const, relativePath: name, path: "", name: "" })),
  );
}

test("ConnectionClosed 不写成永久目录错误，新 attachment 后自动重读根目录", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  assert.equal(harness.fileService.calls.length, 1);
  assert.equal(harness.fileService.calls[0].path, WORKSPACE_PATH);

  harness.fileService.calls[0].reject(connectionClosedError());
  await flushAsync();
  await flushAsync();

  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.tree.loadedDirectoryPaths.has(WORKSPACE_PATH), false);
  // 未加载的根目录保留等待态，避免断线时显示成空目录或永久错误。
  assert.equal(harness.tree.loadingDirectoryPaths.has(WORKSPACE_PATH), true);

  harness.fileService.attach({ attachment: 2 });
  await flushAsync();

  assert.equal(harness.fileService.calls.length, 2);
  assert.equal(harness.fileService.calls[1].path, WORKSPACE_PATH);
  harness.fileService.calls[1].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.tree.loadedDirectoryPaths.has(WORKSPACE_PATH), true);
  assert.equal(harness.tree.loadingDirectoryPaths.has(WORKSPACE_PATH), false);
});

test("根尚未加载时恢复读再次断线仍保持等待，第二次恢复后自动加载", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  assert.equal(harness.fileService.calls.length, 1);
  assert.equal(harness.tree.loadingDirectoryPaths.has(WORKSPACE_PATH), true);

  // 首次加载断线：根目录没有缓存，必须保持等待而不是空目录。
  harness.fileService.calls[0].reject(connectionClosedError());
  await flushAsync();
  await flushAsync();
  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.tree.loadedDirectoryPaths.has(WORKSPACE_PATH), false);
  assert.equal(harness.tree.loadingDirectoryPaths.has(WORKSPACE_PATH), true);

  // 第一个恢复信号触发 silent 重读，但这次读在恢复过程中再次断线。
  harness.fileService.attach({ attachment: 2 });
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 2);
  assert.equal(harness.fileService.calls[1].path, WORKSPACE_PATH);
  harness.fileService.calls[1].reject(connectionClosedError());
  await flushAsync();
  await flushAsync();

  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.tree.loadedDirectoryPaths.has(WORKSPACE_PATH), false);
  // 回归点：silent 恢复读失败不能清掉未加载根的等待态，否则界面显示成空目录。
  assert.equal(harness.tree.loadingDirectoryPaths.has(WORKSPACE_PATH), true);
  assert.deepEqual(harness.tree.rows, []);

  // 第二个恢复信号：自动重读并成功，最终回到正常文件树。
  harness.fileService.attach({ attachment: 3 });
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 3);
  assert.equal(harness.fileService.calls[2].path, WORKSPACE_PATH);
  harness.fileService.calls[2].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.tree.loadedDirectoryPaths.has(WORKSPACE_PATH), true);
  assert.equal(harness.tree.loadingDirectoryPaths.has(WORKSPACE_PATH), false);
  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
});

test("无待恢复标记的透明 attachment 换代不额外重读", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  harness.fileService.calls[0].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  harness.fileService.attach({ attachment: 2 });
  await flushAsync();
  await flushAsync();

  assert.equal(harness.fileService.calls.length, 1);
  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
});

test("rpcReady=false 时暂停读取，false→true 后自动加载（无 connection port）", async () => {
  const harness = createHarness({ rpcReady: false, enabled: false, withConnectionPort: false });
  assert.equal(harness.fileService.calls.length, 0);

  harness.rerender({ rpcReady: true });
  await flushAsync();

  assert.equal(harness.fileService.calls.length, 1);
  harness.fileService.calls[0].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
  assert.equal(harness.tree.errorByDirectory.size, 0);
});

test("普通业务错误仍写入目录错误，且不触发自动重读", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  harness.fileService.calls[0].reject(new Error("EACCES: permission denied"));
  await flushAsync();
  await flushAsync();

  assert.equal(
    harness.tree.errorByDirectory.get(WORKSPACE_PATH)?.message,
    "EACCES: permission denied",
  );

  harness.fileService.attach({ attachment: 2 });
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 1);
});

test("断线保留旧文件与搜索快照，恢复时重读根并重拉搜索索引", async () => {
  const harness = createHarness({ rpcReady: true, enabled: true, withConnectionPort: true });
  harness.fileService.calls[0].resolve([fileEntry("a.txt")]);
  harness.searchCalls[0].resolve(packedEntries(["a.txt"]));
  await flushAsync();
  await flushAsync();

  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
  assert.deepEqual(
    harness.search.entries.map((entry) => entry.name),
    ["a.txt"],
  );

  const refresh = harness.tree.refreshLoadedDirectories();
  await flushAsync();
  const failedRefreshCall = harness.fileService.calls[harness.fileService.calls.length - 1];
  assert.equal(failedRefreshCall.path, WORKSPACE_PATH);
  failedRefreshCall.reject(connectionClosedError());
  await refresh;
  await flushAsync();
  await flushAsync();

  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
  assert.equal(harness.search.error, null);

  harness.fileService.attach({ attachment: 2 });
  await flushAsync();

  assert.equal(harness.fileService.calls.length, 3);
  assert.equal(harness.searchCalls.length, 2);
  harness.fileService.calls[2].resolve([fileEntry("a.txt"), fileEntry("b.txt")]);
  harness.searchCalls[1].resolve(packedEntries(["a.txt", "b.txt"]));
  await flushAsync();
  await flushAsync();

  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt", "b.txt"],
  );
  assert.deepEqual(
    harness.search.entries.map((entry) => entry.name),
    ["a.txt", "b.txt"],
  );
  assert.equal(harness.tree.errorByDirectory.size, 0);
});

test("搜索索引断线不写永久错误，连接恢复后保留旧结果并重拉", async () => {
  const harness = createHarness({ rpcReady: true, enabled: true, withConnectionPort: true });
  harness.fileService.calls[0].resolve([fileEntry("a.txt")]);
  harness.searchCalls[0].reject(connectionClosedError());
  await flushAsync();
  await flushAsync();

  assert.equal(harness.search.error, null);
  assert.equal(harness.search.loaded, false);
  assert.equal(harness.search.loading, true);

  harness.fileService.attach({ attachment: 2 });
  await flushAsync();

  assert.equal(harness.searchCalls.length, 2);
  const recoveredDataCall = harness.fileService.calls[harness.fileService.calls.length - 1];
  recoveredDataCall.resolve([fileEntry("a.txt")]);
  harness.searchCalls[1].resolve(packedEntries(["a.txt"]));
  await flushAsync();
  await flushAsync();

  assert.deepEqual(
    harness.search.entries.map((entry) => entry.name),
    ["a.txt"],
  );
  assert.equal(harness.search.error, null);
  assert.equal(harness.search.loading, false);
});

test("搜索关闭时恢复不拉索引，启用后再正常拉取", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  harness.fileService.calls[0].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  const failed = harness.tree.loadDirectory(WORKSPACE_PATH, 0, { force: true });
  await flushAsync();
  harness.fileService.calls[1].reject(connectionClosedError());
  await failed;
  await flushAsync();

  harness.fileService.attach({ attachment: 2 });
  await flushAsync();

  assert.equal(harness.searchCalls.length, 0);
  assert.equal(harness.fileService.calls.length, 3);
  harness.fileService.calls[2].resolve([fileEntry("a.txt")]);
  await flushAsync();

  harness.rerender({ enabled: true });
  await flushAsync();
  assert.equal(harness.searchCalls.length, 1);
});

test("失败晚于新 attachment 到达时仍会自动恢复，后续透明换代不重复重读", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  assert.equal(harness.fileService.calls.length, 1);

  // 换代信号先到：此时还没有失败，不能重读。
  harness.fileService.attach({ attachment: 2 });
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 1);

  // 属于旧 attachment 的读在换代后才失败：信号已经消费过，不能永久停在等待态。
  harness.fileService.calls[0].reject(connectionClosedError());
  await flushAsync();
  await flushAsync();

  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.fileService.calls.length, 2);
  assert.equal(harness.fileService.calls[1].path, WORKSPACE_PATH);

  harness.fileService.calls[1].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
  assert.equal(harness.tree.loadedDirectoryPaths.has(WORKSPACE_PATH), true);
  assert.equal(harness.tree.loadingDirectoryPaths.has(WORKSPACE_PATH), false);

  // 恢复消费掉的信号不能被下一次透明换代重复消费。
  harness.fileService.attach({ attachment: 3 });
  await flushAsync();
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 2);
});

test("rpcReady 回落后恢复、失败晚于恢复信号时仍会自动重读", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  assert.equal(harness.fileService.calls.length, 1);

  // 连接短暂不可用又恢复；在途读既没有失败也没有待恢复标记，不额外重读。
  harness.rerender({ rpcReady: false });
  harness.rerender({ rpcReady: true });
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 1);

  // 恢复信号已消费、失败后到：仍在旧 transport 上的读必须触发一次重读。
  harness.fileService.calls[0].reject(connectionClosedError());
  await flushAsync();
  await flushAsync();

  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.fileService.calls.length, 2);
  harness.fileService.calls[1].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();
  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
});

test("workspace 切换后旧请求晚失败不写入新工作区，也不产生多余重读", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  const nextWorkspace = createFileService({ withConnectionPort: true });
  const nextPath = "C:\\work2";

  // 旧 workspace 的根读取还在途时切换目标。
  harness.switchWorkspace({
    workspacePath: nextPath,
    services: {
      fileService: nextWorkspace.fileService,
      fileWatcherService: {},
      gitService: {},
    },
  });
  await flushAsync();
  assert.equal(nextWorkspace.calls.length, 1);
  assert.equal(nextWorkspace.calls[0].path, nextPath);

  // 旧请求晚失败：只能得到 stale，不能把待恢复标记或错误带到新 workspace。
  harness.fileService.calls[0].reject(connectionClosedError());
  await flushAsync();
  await flushAsync();

  assert.equal(nextWorkspace.calls.length, 1);
  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.tree.loadingDirectoryPaths.has(nextPath), true);

  // 即使旧连接此时又通知换代，新 workspace 也不应被打扰。
  harness.fileService.attach({ attachment: 2 });
  await flushAsync();
  assert.equal(nextWorkspace.calls.length, 1);

  nextWorkspace.calls[0].resolve([
    { name: "b.txt", path: "C:\\work2\\b.txt", relativePath: "b.txt", type: "file" as const },
  ]);
  await flushAsync();
  await flushAsync();
  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["b.txt"],
  );
  assert.equal(harness.tree.errorByDirectory.size, 0);
});

test("刷新进行中到达的恢复只追加一次重读，不与在途刷新重复", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  harness.fileService.calls[0].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  const refresh = harness.tree.refreshLoadedDirectories();
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 2);

  // 另一次强制读失败，建立待恢复标记。
  const failedRead = harness.tree.loadDirectory(WORKSPACE_PATH, 0, { force: true });
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 3);
  harness.fileService.calls[2].reject(connectionClosedError());
  await failedRead;
  await flushAsync();

  // 恢复信号在刷新批次尚未结束时到达：先记下，等批次收尾再统一重读一次。
  harness.fileService.attach({ attachment: 2 });
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 3);

  harness.fileService.calls[1].resolve([fileEntry("a.txt")]);
  await refresh;
  await flushAsync();
  await flushAsync();

  assert.equal(harness.fileService.calls.length, 4);
  assert.equal(harness.fileService.calls[3].path, WORKSPACE_PATH);
  harness.fileService.calls[3].resolve([fileEntry("a.txt"), fileEntry("b.txt")]);
  await flushAsync();
  await flushAsync();
  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt", "b.txt"],
  );
  assert.equal(harness.tree.errorByDirectory.size, 0);
});

test("搜索启用时失败晚于恢复信号：保留旧结果并只重拉一次索引", async () => {
  const harness = createHarness({ rpcReady: true, enabled: true, withConnectionPort: true });
  harness.fileService.calls[0].resolve([fileEntry("a.txt")]);
  harness.searchCalls[0].resolve(packedEntries(["a.txt"]));
  await flushAsync();
  await flushAsync();
  assert.deepEqual(
    harness.search.entries.map((entry) => entry.name),
    ["a.txt"],
  );

  const failedRead = harness.tree.loadDirectory(WORKSPACE_PATH, 0, { force: true });
  await flushAsync();
  const failedCall = harness.fileService.calls[harness.fileService.calls.length - 1];
  assert.equal(failedCall.path, WORKSPACE_PATH);
  harness.fileService.attach({ attachment: 2 });
  await flushAsync();
  failedCall.reject(connectionClosedError());
  await failedRead;
  await flushAsync();
  await flushAsync();

  assert.equal(harness.tree.errorByDirectory.size, 0);
  // 旧快照在重拉期间继续可见。
  assert.deepEqual(
    harness.search.entries.map((entry) => entry.name),
    ["a.txt"],
  );
  assert.equal(harness.searchCalls.length, 2);

  const recoveredDataCall = harness.fileService.calls[harness.fileService.calls.length - 1];
  recoveredDataCall.resolve([fileEntry("a.txt"), fileEntry("b.txt")]);
  harness.searchCalls[1].resolve(packedEntries(["a.txt", "b.txt"]));
  await flushAsync();
  await flushAsync();

  assert.deepEqual(
    harness.search.entries.map((entry) => entry.name),
    ["a.txt", "b.txt"],
  );
  assert.equal(harness.search.error, null);
  assert.equal(harness.search.loading, false);
});

test("已消费恢复信号后，旧代迟到失败不会污染下一次透明换代", async () => {
  const harness = createHarness({ rpcReady: true, enabled: false, withConnectionPort: true });
  harness.fileService.calls[0].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  // 同一代的两个并发读。
  const firstRead = harness.tree.loadDirectory("C:\\work\\dir", 1, { force: true });
  const secondRead = harness.tree.loadDirectory("C:\\work\\other", 1, { force: true });
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 3);

  // 换代信号先到，两次旧读随后失败：第一次消费信号，第二次属于已恢复的旧代。
  harness.fileService.attach({ attachment: 2 });
  await flushAsync();
  harness.fileService.calls[1].reject(connectionClosedError());
  harness.fileService.calls[2].reject(connectionClosedError());
  await firstRead;
  await secondRead;
  await flushAsync();
  await flushAsync();

  assert.equal(harness.tree.errorByDirectory.size, 0);
  assert.equal(harness.fileService.calls.length, 4);
  harness.fileService.calls[3].resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  // 迟到的第二次失败不能留下待恢复标记：下一次透明换代仍不应重读。
  harness.fileService.attach({ attachment: 3 });
  await flushAsync();
  await flushAsync();
  assert.equal(harness.fileService.calls.length, 4);
  assert.deepEqual(
    harness.tree.rows.map((row) => row.name),
    ["a.txt"],
  );
});

test("搜索启用且 rpcReady 恢复时强制重拉索引并采用新结果", async () => {
  const harness = createHarness({ rpcReady: false, enabled: true, withConnectionPort: true });
  assert.equal(harness.searchCalls.length, 0);

  harness.rerender({ rpcReady: true });
  await flushAsync();
  assert.ok(harness.searchCalls.length > 0);
  const recoveryCall = harness.searchCalls[harness.searchCalls.length - 1];
  assert.equal(recoveryCall.options.refresh, true);
  assert.equal(harness.search.loading, true);

  recoveryCall.resolve(packedEntries(["a.txt"]));
  const treeCall = harness.fileService.calls[harness.fileService.calls.length - 1];
  treeCall.resolve([fileEntry("a.txt")]);
  await flushAsync();
  await flushAsync();

  assert.deepEqual(
    harness.search.entries.map((entry) => entry.name),
    ["a.txt"],
  );
  assert.equal(harness.search.loaded, true);
  assert.equal(harness.search.loading, false);
  assert.equal(harness.search.error, null);
});
