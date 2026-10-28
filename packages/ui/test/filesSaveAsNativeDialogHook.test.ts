// 另存为原生选路的 hook 集成测试。本包没有 DOM 渲染环境（无 vitest / jsdom），
// 沿用 filesMonacoLoaderRetry / workspaceShellSwipeWiring 的做法：用 TypeScript
// Compiler API 编译真实源码，注入一个最小 React hook 运行时来执行 render、effect、
// cleanup 与 promise 续接，而不是只断言 controller 的纯逻辑或源码文本。
//
// 产品规则见 docs/specs/native-path-dialogs.md。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as filesSaveAsNativeDialogModule from "../src/files-workbench/filesSaveAsNativeDialog.js";
import * as filesSaveAsPathModule from "../src/files-workbench/filesSaveAsPath.js";

const hookSource = await readFile(
  new URL("../src/files-workbench/useFilesSaveAsNativeDialog.ts", import.meta.url),
  "utf8",
);
const dialogSource = await readFile(
  new URL("../src/files-workbench/FilesSaveAsDialog.tsx", import.meta.url),
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

const hookOutput = transpile(hookSource);
const dialogOutput = transpile(dialogSource);

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

type Slot = StateSlot | RefSlot | CallbackSlot | EffectSlot;

/**
 * 最小 React hook 运行时：按调用顺序复用 slot，state 写入触发同步重渲染，
 * passive effect 在渲染提交后按依赖执行 cleanup / create，卸载时清理全部 effect。
 */
function createHookRuntime() {
  const slots: Slot[] = [];
  let cursor = 0;
  let rendering = false;
  let renderQueued = false;
  let unmounted = false;
  let renderCount = 0;
  let stateWritesAfterUnmount = 0;
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
        if (unmounted) {
          stateWritesAfterUnmount += 1;
          return;
        }
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

  const useCallback = <T extends (...args: never[]) => unknown>(
    callback: T,
    deps?: readonly unknown[],
  ): T => {
    const index = cursor++;
    let slot = slots[index] as CallbackSlot | undefined;
    if (!slot) {
      slot = { kind: "callback", callback, deps };
      slots[index] = slot;
    } else if (
      deps === undefined ||
      slot.deps === undefined ||
      !dependenciesEqual(slot.deps, deps)
    ) {
      slot.callback = callback;
      slot.deps = deps;
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
        renderCount += 1;
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
    react: { useState, useRef, useCallback, useEffect },
    setRender(implementation: () => unknown) {
      renderImplementation = implementation;
    },
    render,
    unmount,
    get result() {
      return result;
    },
    get renderCount() {
      return renderCount;
    },
    get stateWritesAfterUnmount() {
      return stateWritesAfterUnmount;
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

function loadNativeHookModule(runtime: ReturnType<typeof createHookRuntime>) {
  return loadCommonJs(hookOutput, (id) => {
    switch (id) {
      case "react":
        return runtime.react;
      case "@/files-workbench/filesSaveAsPath.js":
        return filesSaveAsPathModule;
      case "@/files-workbench/filesSaveAsNativeDialog.js":
        return filesSaveAsNativeDialogModule;
      default:
        throw new Error(`未预期的 hook 依赖 ${id}`);
    }
  });
}

interface NativeDialogOptions {
  defaultPath?: string;
  title?: string;
}

interface NativeDialogCall {
  options?: NativeDialogOptions;
  resolve: (path: string | null) => void;
  reject: (error: unknown) => void;
}

function createPlatform() {
  const calls: NativeDialogCall[] = [];
  const platform = {
    canSelectFilePath: true,
    showSaveDialog(options?: NativeDialogOptions): Promise<string | null> {
      return new Promise<string | null>((resolve, reject) => {
        calls.push({ options, resolve, reject });
      });
    },
  };
  return { platform, calls };
}

interface NativeHookParams {
  open: boolean;
  bufferId?: string;
  workspaceKey?: string;
  fileService?: unknown;
  allowNativePath: boolean;
  platform: {
    canSelectFilePath?: boolean;
    showSaveDialog?: (options?: NativeDialogOptions) => Promise<string | null>;
  } | null;
  directory: string;
  fileName: string;
  title: string;
  onConfirm: (path: string) => void;
}

interface NativeHookResult {
  available: boolean;
  pending: boolean;
  failed: boolean;
  openDialog: () => void;
}

function createNativeHookHarness(initial: NativeHookParams) {
  const runtime = createHookRuntime();
  const hookModule = loadNativeHookModule(runtime);
  let params = initial;
  let captured!: NativeHookResult;
  runtime.setRender(() => {
    captured = (
      hookModule.useFilesSaveAsNativeDialog as (value: NativeHookParams) => NativeHookResult
    )(params);
    return captured;
  });
  runtime.render();
  return {
    get captured() {
      return captured;
    },
    rerender(next: Partial<NativeHookParams>) {
      params = { ...params, ...next };
      runtime.render();
    },
    unmount: runtime.unmount,
    runtime,
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface ReadDirCall {
  path: string;
  resolve: (entries: unknown[]) => void;
  reject: (error: unknown) => void;
}

function createReaddirService() {
  const calls: ReadDirCall[] = [];
  const fileService = {
    readdir({ path }: { path: string }): Promise<unknown[]> {
      return new Promise<unknown[]>((resolve, reject) => {
        calls.push({ path, resolve, reject });
      });
    },
  };
  return { fileService, calls };
}

interface DialogProps {
  open: boolean;
  bufferId?: string;
  workspaceKey?: string;
  defaultDirectory?: string;
  defaultFileName?: string;
  fileService?: unknown;
  allowNativePath?: boolean;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}

function createDialogHarness(initial: DialogProps, platform: unknown = null) {
  const runtime = createHookRuntime();
  const Input = () => null;
  const Button = () => null;
  const Dialog = () => null;
  const DialogContent = () => null;
  const DialogFooter = () => null;
  const DialogHeader = () => null;
  const DialogTitle = () => null;
  const ArrowLeft = () => null;
  const Folder = () => null;
  const hookModule = loadNativeHookModule(runtime);
  const dialogModule = loadCommonJs(dialogOutput, (id) => {
    switch (id) {
      case "react":
        return runtime.react;
      case "react/jsx-runtime":
        return {
          jsx: (type: unknown, props: unknown) => ({ type, props }),
          jsxs: (type: unknown, props: unknown) => ({ type, props }),
          Fragment: "Fragment",
        };
      case "lucide-react":
        return { ArrowLeft, Folder };
      case "@/components/ui/button.js":
        return { Button };
      case "@/components/ui/dialog.js":
        return { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle };
      case "@/components/ui/input.js":
        return { Input };
      case "@/hooks/usePlatform.js":
        return { useOptionalPlatform: () => platform };
      case "@/i18n/IntlProvider.js":
        return {
          useZCodeIntl: () => ({
            intl: { formatMessage: ({ id }: { id: string }) => id },
          }),
        };
      case "@/files-workbench/filesSaveAsPath.js":
        return filesSaveAsPathModule;
      case "@/files-workbench/useFilesSaveAsNativeDialog.js":
        return hookModule;
      case "@/logger.js":
        return { logger: { warn: () => undefined } };
      default:
        throw new Error(`未预期的弹窗依赖 ${id}`);
    }
  });
  let props = initial;
  runtime.setRender(() =>
    (dialogModule.FilesSaveAsDialog as (value: DialogProps) => unknown)(props),
  );
  runtime.render();
  return {
    rerender(next: Partial<DialogProps>) {
      props = { ...props, ...next };
      runtime.render();
    },
    unmount: runtime.unmount,
    runtime,
    Input,
    get tree() {
      return runtime.result;
    },
  };
}

function walk(
  node: unknown,
  visit: (node: { type?: unknown; props?: Record<string, unknown> }) => void,
) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  visit(element);
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) walk(child, visit);
  } else {
    walk(children, visit);
  }
}

function renderedDirectory(tree: unknown): string | undefined {
  let directory: string | undefined;
  walk(tree, (node) => {
    if (
      node.type === "p" &&
      typeof node.props?.className === "string" &&
      node.props.className.includes("truncate") &&
      typeof node.props.children === "string"
    ) {
      directory = node.props.children;
    }
  });
  return directory;
}

function renderedEntryNames(tree: unknown): string[] {
  const names: string[] = [];
  walk(tree, (node) => {
    if (
      node.type === "span" &&
      typeof node.props?.className === "string" &&
      node.props.className.includes("truncate") &&
      typeof node.props.children === "string"
    ) {
      names.push(node.props.children);
    }
  });
  return names;
}

function renderedFileName(tree: unknown, inputType: unknown): string | undefined {
  let fileName: string | undefined;
  walk(tree, (node) => {
    if (node.type === inputType) fileName = node.props?.value as string | undefined;
  });
  return fileName;
}

function clickEntry(tree: unknown, name: string) {
  let clicked = false;
  walk(tree, (node) => {
    if (node.type !== "button" || clicked) return;
    const children = node.props?.children;
    if (Array.isArray(children) && children.some((child) => child?.props?.children === name)) {
      (node.props?.onClick as (() => void) | undefined)?.();
      clicked = true;
    }
  });
  assert.equal(clicked, true, `找不到目录项 ${name}`);
}

function directoryEntry(name: string, path: string) {
  return { name, path, type: "directory" };
}

function nativeParams(overrides?: Partial<NativeHookParams>): NativeHookParams {
  const { platform } = createPlatform();
  return {
    open: true,
    bufferId: "buffer-a",
    workspaceKey: "/work",
    fileService: {},
    allowNativePath: true,
    platform,
    directory: "/work/docs",
    fileName: "note.txt",
    title: "另存为",
    onConfirm: () => undefined,
    ...overrides,
  };
}

test("hook：默认路径取当前目录与文件名，请求中重复点击只打开一次", async () => {
  const { platform, calls } = createPlatform();
  const confirmed: string[] = [];
  const harness = createNativeHookHarness(
    nativeParams({ platform, onConfirm: (path) => confirmed.push(path) }),
  );

  harness.captured.openDialog();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.options, {
    defaultPath: "/work/docs/note.txt",
    title: "另存为",
  });
  assert.equal(harness.captured.pending, true);

  harness.captured.openDialog();
  assert.equal(calls.length, 1);

  calls[0]!.resolve("/picked.txt");
  await flushAsync();
  assert.deepEqual(confirmed, ["/picked.txt"]);
  assert.equal(harness.captured.pending, false);
  assert.equal(harness.captured.failed, false);
});

test("hook：原生取消不确认；失败提示在改动目标后清除并可重试", async () => {
  const { platform, calls } = createPlatform();
  const confirmed: string[] = [];
  const harness = createNativeHookHarness(
    nativeParams({ platform, onConfirm: (path) => confirmed.push(path) }),
  );

  harness.captured.openDialog();
  calls[0]!.resolve(null);
  await flushAsync();
  assert.deepEqual(confirmed, []);
  assert.equal(harness.captured.pending, false);
  assert.equal(harness.captured.failed, false);

  harness.captured.openDialog();
  calls[1]!.reject(new Error("dialog-broken"));
  await flushAsync();
  assert.deepEqual(confirmed, []);
  assert.equal(harness.captured.pending, false);
  assert.equal(harness.captured.failed, true);

  harness.rerender({ fileName: "renamed.txt" });
  assert.equal(harness.captured.failed, false);

  harness.captured.openDialog();
  assert.deepEqual(calls[2]?.options, {
    defaultPath: "/work/docs/renamed.txt",
    title: "另存为",
  });
  calls[2]!.resolve("/work/docs/renamed.txt");
  await flushAsync();
  assert.deepEqual(confirmed, ["/work/docs/renamed.txt"]);
});

test("hook：关闭弹窗后迟到的原生路径不得确认", async () => {
  const { platform, calls } = createPlatform();
  const confirmed: string[] = [];
  const harness = createNativeHookHarness(
    nativeParams({ platform, onConfirm: (path) => confirmed.push(path) }),
  );

  harness.captured.openDialog();
  harness.rerender({ open: false });
  calls[0]!.resolve("/late.txt");
  await flushAsync();

  assert.deepEqual(confirmed, []);
  assert.equal(harness.captured.pending, false);
});

test("hook：关闭后再次点击不会为已关闭的弹窗打开系统对话框", () => {
  const { platform, calls } = createPlatform();
  const harness = createNativeHookHarness(nativeParams({ platform }));

  harness.rerender({ open: false });
  harness.captured.openDialog();
  assert.equal(calls.length, 0);
});

test("hook：更换缓冲 / 工作区 / 文件服务后旧路径作废，新目标可立即重新选择", async () => {
  const { platform, calls } = createPlatform();
  const confirmedA: string[] = [];
  const confirmedB: string[] = [];
  const harness = createNativeHookHarness(
    nativeParams({ platform, onConfirm: (path) => confirmedA.push(path) }),
  );

  harness.captured.openDialog();
  assert.deepEqual(calls[0]?.options?.defaultPath, "/work/docs/note.txt");

  harness.rerender({
    bufferId: "buffer-b",
    workspaceKey: "/work-b",
    fileService: { label: "b" },
    directory: "/work-b",
    fileName: "other.txt",
    onConfirm: (path) => confirmedB.push(path),
  });

  calls[0]!.resolve("/late-a.txt");
  await flushAsync();
  assert.deepEqual(confirmedA, []);
  assert.deepEqual(confirmedB, []);

  harness.captured.openDialog();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.options?.defaultPath, "/work-b/other.txt");
  calls[1]!.resolve("/work-b/other.txt");
  await flushAsync();
  assert.deepEqual(confirmedA, []);
  assert.deepEqual(confirmedB, ["/work-b/other.txt"]);
});

test("hook：旧原生错误不影响新目标的请求中状态", async () => {
  const { platform, calls } = createPlatform();
  const confirmed: string[] = [];
  const harness = createNativeHookHarness(
    nativeParams({ platform, onConfirm: (path) => confirmed.push(path) }),
  );

  harness.captured.openDialog();
  harness.rerender({ bufferId: "buffer-b", fileName: "b.txt" });
  harness.captured.openDialog();
  assert.equal(calls.length, 2);

  calls[0]!.reject(new Error("old-target-error"));
  await flushAsync();
  assert.equal(harness.captured.pending, true);
  assert.equal(harness.captured.failed, false);

  calls[1]!.resolve("/b.txt");
  await flushAsync();
  assert.deepEqual(confirmed, ["/b.txt"]);
});

test("hook：allowNativePath 变为 false 后旧路径与旧错误都作废", async () => {
  const { platform, calls } = createPlatform();
  const confirmed: string[] = [];
  const harness = createNativeHookHarness(
    nativeParams({ platform, onConfirm: (path) => confirmed.push(path) }),
  );

  harness.captured.openDialog();
  harness.rerender({ allowNativePath: false });
  assert.equal(harness.captured.available, false);
  assert.equal(harness.captured.pending, false);

  calls[0]!.resolve("/stale-local-path.txt");
  await flushAsync();
  assert.deepEqual(confirmed, []);
  assert.equal(harness.captured.failed, false);

  harness.captured.openDialog();
  assert.equal(calls.length, 1);
});

test("hook：原生确认使用重渲染后的最新 onConfirm，不保留旧闭包", async () => {
  const { platform, calls } = createPlatform();
  const confirmedA: string[] = [];
  const confirmedB: string[] = [];
  const harness = createNativeHookHarness(
    nativeParams({ platform, onConfirm: (path) => confirmedA.push(path) }),
  );

  harness.captured.openDialog();
  harness.rerender({ onConfirm: (path) => confirmedB.push(path) });
  calls[0]!.resolve("/latest.txt");
  await flushAsync();

  assert.deepEqual(confirmedA, []);
  assert.deepEqual(confirmedB, ["/latest.txt"]);
});

test("弹窗：关闭后迟到的目录读取不覆盖当前列表", async () => {
  const { fileService, calls } = createReaddirService();
  const harness = createDialogHarness({
    open: true,
    bufferId: "buffer-a",
    defaultDirectory: "/work",
    defaultFileName: "a.txt",
    fileService,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  });
  assert.equal(calls.length, 1);

  harness.rerender({ open: false });
  calls[0]!.resolve([directoryEntry("stale", "/work/stale")]);
  await flushAsync();

  assert.deepEqual(renderedEntryNames(harness.tree), []);
});

test("弹窗：卸载后迟到的目录读取不再写状态", async () => {
  const { fileService, calls } = createReaddirService();
  const harness = createDialogHarness({
    open: true,
    defaultDirectory: "/work",
    defaultFileName: "a.txt",
    fileService,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  });
  assert.equal(calls.length, 1);

  harness.unmount();
  calls[0]!.resolve([directoryEntry("stale", "/work/stale")]);
  await flushAsync();

  assert.equal(harness.runtime.stateWritesAfterUnmount, 0);
});

test("弹窗：同名目录的目标更换后，旧文件服务的迟到结果不覆盖新目标", async () => {
  const first = createReaddirService();
  const second = createReaddirService();
  const harness = createDialogHarness({
    open: true,
    bufferId: "buffer-a",
    workspaceKey: "/work",
    defaultDirectory: "/work",
    defaultFileName: "note.txt",
    fileService: first.fileService,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  });

  harness.rerender({
    bufferId: "buffer-b",
    fileService: second.fileService,
  });
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);

  first.calls[0]!.resolve([directoryEntry("from-a", "/work/from-a")]);
  await flushAsync();
  assert.deepEqual(renderedEntryNames(harness.tree), []);

  second.calls[0]!.resolve([directoryEntry("from-b", "/work/from-b")]);
  await flushAsync();
  assert.deepEqual(renderedEntryNames(harness.tree), ["from-b"]);
});

test("弹窗：同一文件服务内更换缓冲也作废在途目录读取并回到默认目录", async () => {
  const { fileService, calls } = createReaddirService();
  const harness = createDialogHarness({
    open: true,
    bufferId: "buffer-a",
    defaultDirectory: "/work",
    defaultFileName: "note.txt",
    fileService,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  });

  calls[0]!.resolve([directoryEntry("sub", "/work/sub")]);
  await flushAsync();
  assert.deepEqual(renderedEntryNames(harness.tree), ["sub"]);

  clickEntry(harness.tree, "sub");
  assert.equal(calls.length, 2);

  harness.rerender({ bufferId: "buffer-b" });
  // 目标更换后应立刻回到新目标的默认目录。
  assert.equal(renderedDirectory(harness.tree), "/work");

  calls[1]!.resolve([directoryEntry("late-sub", "/work/sub/late-sub")]);
  await flushAsync();
  assert.equal(renderedDirectory(harness.tree), "/work");
  assert.deepEqual(renderedEntryNames(harness.tree), []);
});

test("弹窗：关闭后再打开且目录读取失败时不保留上一次的目录与条目", async () => {
  const first = createReaddirService();
  const harness = createDialogHarness({
    open: true,
    defaultDirectory: "/old",
    defaultFileName: "old.txt",
    fileService: first.fileService,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  });
  first.calls[0]!.resolve([directoryEntry("stale", "/old/stale")]);
  await flushAsync();
  assert.equal(renderedDirectory(harness.tree), "/old");
  assert.deepEqual(renderedEntryNames(harness.tree), ["stale"]);

  harness.rerender({ open: false });

  const second = createReaddirService();
  harness.rerender({
    open: true,
    defaultDirectory: "/new",
    defaultFileName: "new.txt",
    fileService: second.fileService,
  });
  second.calls[0]!.reject(new Error("directory-unavailable"));
  await flushAsync();

  assert.equal(renderedDirectory(harness.tree), "/new");
  assert.deepEqual(renderedEntryNames(harness.tree), []);
  assert.equal(renderedFileName(harness.tree, harness.Input), "new.txt");
});
