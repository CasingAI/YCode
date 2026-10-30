import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FilesEditorGroupPane } from "../src/files-workbench/FilesEditorGroupPane.js";
import { FilesEditorMarkdownModeSwitch } from "../src/files-workbench/FilesEditorMarkdownModeSwitch.js";
import { FilesEditorTabBar } from "../src/files-workbench/FilesEditorTabBar.js";
import { isFilesEditorTabBarCompact } from "../src/files-workbench/filesEditorTabSizing.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import {
  createFilesEditorLayoutWithViews,
  replaceFilesEditorViewBuffer,
  setFilesEditorViewMarkdownViewMode,
} from "../src/files-workbench/filesEditorLayout.js";
import { splitFilesEditorViewToEdge } from "../src/files-workbench/filesEditorLayoutOperations.js";
import {
  createLargeTextFileBuffer,
  createTextFileBuffer,
  isFilesBufferDirty,
} from "../src/files-workbench/filesEditorModel.js";
import {
  isFilesEditorMarkdownPreviewAvailable,
  resolveFilesEditorMarkdownViewMode,
} from "../src/files-workbench/filesEditorMarkdownMode.js";
import type {
  FilesBuffer,
  FilesPreviewBuffer,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";
import type { FilesEditorTabEntry } from "../src/files-workbench/filesEditorTabAnimation.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/workspace" };

function textBuffer(path: string, text = "# Saved"): FilesTextBuffer {
  return createTextFileBuffer({ workspace, path, text });
}

function render(children: ReactNode): string {
  return renderToStaticMarkup(
    createElement(ServiceProvider, {
      services: {} as IServiceAccessor,
      children: createElement(PlatformProvider, {
        platform: {} as IPlatformService,
        children: createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children }),
      }),
    }),
  );
}

test("Markdown 可用性矩阵：已加载、有路径、非截断的 Markdown 文本才提供预览", () => {
  for (const path of [
    "/workspace/README.md",
    "/workspace/docs/guide.markdown",
    "/workspace/docs/page.mdx",
    "/workspace/README",
    "/workspace/readme.md",
  ]) {
    assert.equal(
      isFilesEditorMarkdownPreviewAvailable(textBuffer(path)),
      true,
      `${path} 应识别为 Markdown`,
    );
  }

  // 用户文件关联把非标准扩展名映射到 markdown。
  assert.equal(
    isFilesEditorMarkdownPreviewAvailable(textBuffer("/workspace/notes.prose"), {
      "*.prose": "markdown",
    }),
    true,
  );

  // 非 Markdown、plaintext 特殊文件名、未命名、未加载 / 加载中 / 失败、截断和大文本都不提供。
  assert.equal(isFilesEditorMarkdownPreviewAvailable(textBuffer("/workspace/main.ts")), false);
  assert.equal(isFilesEditorMarkdownPreviewAvailable(textBuffer("/workspace/license.md")), false);
  assert.equal(
    isFilesEditorMarkdownPreviewAvailable({
      ...textBuffer("/workspace/Untitled.md"),
      untitled: true,
    }),
    false,
  );
  for (const loadState of ["unloaded", "loading", "error"] as const) {
    assert.equal(
      isFilesEditorMarkdownPreviewAvailable({
        ...textBuffer("/workspace/README.md"),
        loadState,
      }),
      false,
    );
  }
  assert.equal(
    isFilesEditorMarkdownPreviewAvailable({
      ...textBuffer("/workspace/README.md"),
      truncated: true,
    }),
    false,
  );
  assert.equal(
    isFilesEditorMarkdownPreviewAvailable(
      createLargeTextFileBuffer({ workspace, path: "/workspace/huge.md" }),
    ),
    false,
  );
  const previewBuffer: FilesPreviewBuffer = {
    id: "preview:image",
    kind: "preview",
    path: "/workspace/diagram.md",
    title: "diagram.md",
    workspace,
  };
  assert.equal(isFilesEditorMarkdownPreviewAvailable(previewBuffer), false);
  assert.equal(isFilesEditorMarkdownPreviewAvailable(undefined), false);
});

test("模式按 view 隔离：同一 buffer 两个视图互不影响，source 清除默认值", () => {
  const layout = createFilesEditorLayoutWithViews("group", [
    { id: "view-a", bufferId: "buffer" },
    { id: "view-b", bufferId: "buffer" },
  ]);

  const previewA = setFilesEditorViewMarkdownViewMode(layout, "view-a", "preview");
  assert.equal(previewA.groups.group?.views[0]?.markdownViewMode, "preview");
  assert.equal(previewA.groups.group?.views[1]?.markdownViewMode, undefined);

  const previewBoth = setFilesEditorViewMarkdownViewMode(previewA, "view-b", "preview");
  assert.equal(previewBoth.groups.group?.views[0]?.markdownViewMode, "preview");
  assert.equal(previewBoth.groups.group?.views[1]?.markdownViewMode, "preview");

  const sourceA = setFilesEditorViewMarkdownViewMode(previewBoth, "view-a", "source");
  assert.equal(sourceA.groups.group?.views[0]?.markdownViewMode, undefined);
  assert.equal(sourceA.groups.group?.views[1]?.markdownViewMode, "preview");

  // 不存在或重复设置相同模式时返回原布局引用。
  assert.equal(setFilesEditorViewMarkdownViewMode(sourceA, "missing", "preview"), sourceA);
  assert.equal(setFilesEditorViewMarkdownViewMode(sourceA, "view-b", "preview"), sourceA);
});

test("view 更换 buffer 时清除 Markdown 模式，复制出的分屏默认源码", () => {
  const layout = setFilesEditorViewMarkdownViewMode(
    createFilesEditorLayoutWithViews("group", [{ id: "view", bufferId: "buffer-a" }]),
    "view",
    "preview",
  );
  const replaced = replaceFilesEditorViewBuffer(layout, "view", "buffer-b");
  assert.equal(replaced.groups.group?.views[0]?.bufferId, "buffer-b");
  assert.equal(replaced.groups.group?.views[0]?.markdownViewMode, undefined);

  // 分屏复制走 layout 操作：新 view 只有 id / bufferId，默认源码；
  // 原 view 的预览模式保留，两边互不覆盖。
  const previewLayout = setFilesEditorViewMarkdownViewMode(
    createFilesEditorLayoutWithViews("group", [{ id: "view", bufferId: "buffer" }]),
    "view",
    "preview",
  );
  const split = splitFilesEditorViewToEdge(previewLayout, "view", "group", "right", {
    groupId: "group-copy",
    branchId: "branch-copy",
    viewId: "view-copy",
  });
  assert.equal(split.groups["group-copy"]?.views[0]?.bufferId, "buffer");
  assert.equal(split.groups["group-copy"]?.views[0]?.markdownViewMode, undefined);
  assert.equal(split.groups.group?.views[0]?.markdownViewMode, "preview");
});

test("Store action 只改 layout 模式，不改正文、基准、脏态、预览或固定状态", () => {
  const store = createFilesEditorStore();
  const buffer = {
    ...textBuffer("/workspace/README.md", "# Saved"),
    text: "# Draft",
    preview: true,
  } satisfies FilesTextBuffer;
  store.getState().openBuffer(buffer, "preview");
  const layout = store.getState().layout;
  const group = layout.groups[layout.focusedGroupId]!;
  const viewId = group.views[0]!.id;

  store.getState().setViewMarkdownViewMode(viewId, "preview");

  const next = store.getState();
  const current = next.buffers.find((candidate) => candidate.id === buffer.id) as FilesTextBuffer;
  assert.equal(current.text, "# Draft");
  assert.equal(current.savedText, "# Saved");
  assert.equal(current.preview, true);
  assert.equal(isFilesBufferDirty(current), true);
  const nextView = next.layout.groups[layout.focusedGroupId]!.views[0]!;
  assert.equal(nextView.markdownViewMode, "preview");
  // layout 模式不进入持久化会话快照。
  assert.doesNotMatch(JSON.stringify(next.snapshotSession()), /markdownViewMode/);

  store.getState().setViewMarkdownViewMode(viewId, "source");
  assert.equal(
    store.getState().layout.groups[layout.focusedGroupId]!.views[0]!.markdownViewMode,
    undefined,
  );
  const after = store.getState().buffers.find((candidate) => candidate.id === buffer.id);
  assert.equal(after, current, "切换模式不得重建缓冲对象");
});

test("辅助函数对当前 view 返回展示模式，并用最新语言关联判断", () => {
  const view = { id: "view", bufferId: "buffer", markdownViewMode: "preview" as const };
  assert.equal(
    resolveFilesEditorMarkdownViewMode(view, textBuffer("/workspace/README.md")),
    "preview",
  );
  assert.equal(
    resolveFilesEditorMarkdownViewMode(view, textBuffer("/workspace/main.ts")),
    undefined,
  );
  assert.equal(
    resolveFilesEditorMarkdownViewMode(view, textBuffer("/workspace/notes.prose"), {
      "*.prose": "markdown",
    }),
    "preview",
  );
});

function createTab(viewId: string, buffer: FilesBuffer): FilesEditorTabEntry {
  return { viewId, buffer };
}

function tabBarProps(
  tabs: readonly FilesEditorTabEntry[],
  markdownViewMode?: "source" | "preview",
): ComponentProps<typeof FilesEditorTabBar> {
  const noop = () => {};
  return {
    groupId: "main",
    tabs,
    activeViewId: tabs[0]?.viewId,
    canCloseSaved: true,
    canRevealInFileTree: () => true,
    onActivate: noop,
    onKeepOpen: noop,
    onClose: noop,
    onCloseOthers: noop,
    onCloseToRight: noop,
    onCloseSaved: noop,
    onCloseAll: noop,
    onCopyPath: noop,
    onRevealInFileTree: noop,
    onSplit: noop,
    onMoveView: noop,
    onCreateUntitled: noop,
    onSave: noop,
    onSaveAs: noop,
    ...(markdownViewMode ? { markdownViewMode, onSetMarkdownViewMode: noop } : undefined),
  };
}

function modeButtons(markup: string): string[] {
  return Array.from(markup.matchAll(/<button\b[^>]*>/g), (match) => match[0]).filter((tag) =>
    tag.includes("data-files-markdown-mode="),
  );
}

test("标签条分段控件只对 Markdown 活动标签出现，两态 aria-pressed 明确", () => {
  const source = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        FilesEditorTabBar,
        tabBarProps([createTab("view", textBuffer("/workspace/README.md"))], "source"),
      ),
    ),
  );
  assert.match(source, /data-files-markdown-mode-switch=""/);
  const sourceButtons = modeButtons(source);
  assert.equal(sourceButtons.length, 2);
  assert.match(sourceButtons[0]!, /aria-pressed="true"/);
  assert.match(sourceButtons[0]!, /data-files-markdown-mode="source"/);
  assert.match(source, />源码<\/button>/);
  assert.match(sourceButtons[1]!, /aria-pressed="false"/);
  assert.match(sourceButtons[1]!, /data-files-markdown-mode="preview"/);
  assert.match(source, />预览<\/button>/);

  const preview = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        FilesEditorTabBar,
        tabBarProps([createTab("view", textBuffer("/workspace/README.md"))], "preview"),
      ),
    ),
  );
  const previewButtons = modeButtons(preview);
  assert.match(previewButtons[0]!, /aria-pressed="false"/);
  assert.match(previewButtons[1]!, /aria-pressed="true"/);

  const nonMarkdown = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        FilesEditorTabBar,
        tabBarProps([createTab("view", textBuffer("/workspace/main.ts"))]),
      ),
    ),
  );
  assert.doesNotMatch(nonMarkdown, /data-files-markdown-mode-switch/);
});

test("窄组分段控件改用图标并保留完整无障碍名称", () => {
  const markup = render(
    createElement(FilesEditorMarkdownModeSwitch, {
      mode: "source",
      onChange: () => {},
      compact: true,
    }),
  );
  assert.match(markup, /data-files-markdown-mode-compact=""/);
  const buttons = modeButtons(markup);
  assert.equal(buttons.length, 2);
  assert.match(buttons[0]!, /aria-label="源码"/);
  assert.match(buttons[0]!, /title="源码"/);
  assert.match(buttons[1]!, /aria-label="预览"/);
  assert.match(buttons[1]!, /title="预览"/);
  assert.doesNotMatch(markup, />源码<\/button>/);
  assert.match(markup, /<svg[^>]*aria-hidden="true"/);
});

test("紧凑阈值按组容器宽度判断，320 / 375 均为窄组", () => {
  assert.equal(isFilesEditorTabBarCompact(320), true);
  assert.equal(isFilesEditorTabBarCompact(375), true);
  assert.equal(isFilesEditorTabBarCompact(419), true);
  assert.equal(isFilesEditorTabBarCompact(420), false);
  assert.equal(isFilesEditorTabBarCompact(0), false);
  assert.equal(isFilesEditorTabBarCompact(Number.NaN), false);
});

type GroupProps = ComponentProps<typeof FilesEditorGroupPane>;

function groupProps(buffer: FilesBuffer, markdownViewMode?: "source" | "preview"): GroupProps {
  const noop = () => {};
  return {
    group: {
      id: "group",
      views: [
        {
          id: "view",
          bufferId: buffer.id,
          ...(markdownViewMode ? { markdownViewMode } : undefined),
        },
      ],
      activeViewId: "view",
    },
    buffers: [buffer],
    isActiveView: true,
    hasEnteredFiles: true,
    isFocused: true,
    loadRestoredTextFile: async () => {},
    onActivate: noop,
    onKeepOpen: noop,
    onClose: noop,
    onCloseOthers: noop,
    onCloseToRight: noop,
    onCloseSaved: noop,
    onCloseAll: noop,
    canCloseSaved: false,
    onCopyPath: noop,
    onRevealInFileTree: noop,
    canRevealInFileTree: () => false,
    onMoveView: noop,
    onSplit: noop,
    onChange: noop,
    onOpenPath: () => false,
    onRevealPositionApplied: noop,
    onCreateUntitled: noop,
    onSave: noop,
    onSaveAs: noop,
    onExternalChangeAction: noop,
    onFocusGroup: noop,
    onSetMarkdownViewMode: noop,
  };
}

test("预览渲染当前缓冲正文而不是已保存正文，源码态不挂预览", () => {
  const buffer = {
    ...textBuffer("/workspace/README.md", "# Saved Heading"),
    text: "# Unsaved Heading",
  } satisfies FilesTextBuffer;

  const preview = render(createElement(FilesEditorGroupPane, groupProps(buffer, "preview")));
  assert.match(preview, /data-files-markdown-preview=""/);
  assert.match(preview, /Unsaved Heading/);
  assert.doesNotMatch(preview, /Saved Heading/);
  // 源码编辑器仍挂载并被覆盖层隔离。
  assert.match(preview, /inert=""/);

  const source = render(createElement(FilesEditorGroupPane, groupProps(buffer, "source")));
  assert.doesNotMatch(source, /data-files-markdown-preview/);
  assert.doesNotMatch(source, /Unsaved Heading/);
  assert.doesNotMatch(source, /inert=""/);
  assert.match(source, /data-files-markdown-mode-switch=""/);
});

test("非 Markdown 缓冲即使布局残留预览模式也不渲染预览", () => {
  const markup = render(
    createElement(
      FilesEditorGroupPane,
      groupProps(textBuffer("/workspace/main.ts", "const x = 1;"), "preview"),
    ),
  );
  assert.doesNotMatch(markup, /data-files-markdown-preview/);
  assert.doesNotMatch(markup, /data-files-markdown-mode-switch/);
  assert.doesNotMatch(markup, /inert=""/);
});
