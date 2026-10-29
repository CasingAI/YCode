import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  FilesLargeTextDecodingNotices,
  FilesLargeTextViewer,
  resolveFilesLargeTextBlockProjection,
} from "../src/files-workbench/FilesLargeTextViewer.js";
import { FilesEditorGroupPane } from "../src/files-workbench/FilesEditorGroupPane.js";
import { FilesEditorStoreProvider } from "../src/files-workbench/FilesEditorStoreProvider.js";
import { createLargeTextFileBuffer } from "../src/files-workbench/filesEditorModel.js";
import { createFilesLargeTextEditState } from "../src/files-workbench/filesLargeTextDraftModel.js";
import type { FilesLargeTextBlockSlice } from "../src/files-workbench/filesLargeTextBlockModel.js";
import { filesLargeTextWindowModelUri } from "../src/files-workbench/filesLargeTextWindowTypes.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/workspace" };
const TOTAL = 10 * 1024 * 1024;

function render(children: ReactNode): string {
  return renderToStaticMarkup(
    createElement(ServiceProvider, {
      services: {} as IServiceAccessor,
      children: createElement(PlatformProvider, {
        platform: {} as IPlatformService,
        children: createElement(ZCodeIntlProvider, {
          initialLocale: "zh-CN",
          children: createElement(FilesEditorStoreProvider, { children }),
        }),
      }),
    }),
  );
}

function largeBuffer() {
  return createLargeTextFileBuffer({
    workspace,
    path: "/workspace/huge.log",
    totalBytes: TOTAL,
  });
}

test("大文件 viewer 投影只读、范围、大小、片段搜索与定位入口", () => {
  const markup = render(
    createElement(FilesLargeTextViewer, { buffer: largeBuffer(), active: false }),
  );
  assert.match(markup, /data-files-large-text-viewer=""/);
  assert.match(markup, /data-files-large-text-toolbar=""/);
  assert.match(markup, /role="toolbar"/);
  assert.match(markup, /aria-label="大文件浏览"/);
  assert.match(markup, /只读/);
  assert.match(markup, /仅当前片段搜索/);
  assert.match(markup, /不显示全文件行号/);
  assert.match(markup, /10\.0 MiB/);
  assert.match(markup, /10485760 字节/);
  // 未激活 / 尚未读窗口时不渲染 Monaco，也不显示可编辑加载态。
  assert.doesNotMatch(markup, /monaco/i);
  assert.doesNotMatch(markup, /正在加载文件/);
  assert.doesNotMatch(markup, /files-editor-status-bar/);
});

test("encoding 提示只说明部分块只读，不把整个大文件说成不能保存", () => {
  const buffer = { ...largeBuffer(), readonlyReason: "encoding" as const };
  const markup = render(createElement(FilesLargeTextViewer, { buffer, active: false }));
  assert.match(markup, /data-files-large-text-encoding=""/);
  assert.match(markup, /当前块只读，其它块仍可编辑保存/);
  assert.doesNotMatch(markup, /不能保存/);
  assert.doesNotMatch(markup, /data-files-large-text-decoding-errors=""/);
});

test("当前窗口 hasDecodingErrors 只标片段无损提示，不声称全文件错误位置", () => {
  const markup = render(createElement(FilesLargeTextDecodingNotices, { hasDecodingErrors: true }));
  assert.match(markup, /data-files-large-text-decoding-errors=""/);
  assert.match(markup, /当前片段包含无法无损解码的 UTF-8 字节/);
  assert.match(markup, /不代表全文件具体位置/);
  // 不提供具体字节位置或行号，避免把窗口内错误说成全文件位置。
  assert.doesNotMatch(markup, /第\s*\d+\s*字节|行号\s*\d+|字节\s*\d+/);
});

test("多分屏 viewer 的定位输入 id 由 useId 派生且互不重复", () => {
  const markup = render(
    createElement(
      "div",
      null,
      createElement(FilesLargeTextViewer, { buffer: largeBuffer(), active: false }),
      createElement(FilesLargeTextViewer, { buffer: largeBuffer(), active: false }),
    ),
  );
  const ids = Array.from(
    markup.matchAll(/id="([^"]*(?:percent|offset)[^"]*)"/g),
    (match) => match[1],
  );
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotMatch(markup, /id="files-large-text-(percent|offset)/);
});

test("320px 工具栏使用可换行布局，定位输入不横向挤出", () => {
  const markup = render(
    createElement(FilesLargeTextViewer, { buffer: largeBuffer(), active: false }),
  );
  const toolbar = markup.match(/data-files-large-text-toolbar=""[^>]*/)?.[0] ?? "";
  assert.match(toolbar, /flex-wrap/);
  assert.match(toolbar, /min-w-0/);
  assert.doesNotMatch(toolbar, /overflow-x|min-w-\[/);

  const formClasses = Array.from(
    markup.matchAll(/<form[^>]*class="([^"]*)"/g),
    (match) => match[1] ?? "",
  );
  assert.ok(formClasses.length >= 3);
  for (const classes of formClasses) {
    assert.match(classes, /flex-wrap/);
    assert.match(classes, /min-w-0/);
  }
  // 工具栏提供百分比滑块 + 百分比数字输入 + 字节偏移输入三条可达路径。
  assert.match(markup, /type="range"/);
  assert.match(markup, /accent-brand/);
  assert.doesNotMatch(markup, /accent-\[var\(/);
  assert.match(markup, /id="[^"]*-percent"/);
  assert.match(markup, /id="[^"]*-offset"/);
  assert.match(markup, /for="[^"]*-percent"/);
  assert.match(markup, /for="[^"]*-offset"/);
  // 数字输入在移动端使用 16px 安全字号，桌面再回到 ui-base。
  assert.match(markup, /text-mobile-input-safe md:text-ui-base/);
  assert.match(markup, /aria-label="按文件字节百分比定位"/);
});

function groupProps(
  buffer: ReturnType<typeof largeBuffer>,
): ComponentProps<typeof FilesEditorGroupPane> {
  const noop = () => {};
  return {
    group: {
      id: "group",
      views: [{ id: "view", bufferId: buffer.id }],
      activeViewId: "view",
    },
    buffers: [buffer],
    isActiveView: false,
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
  };
}

test("块投影只套用同 offset 且原始文本一致的修改", () => {
  const block: FilesLargeTextBlockSlice = {
    blockIndex: 1,
    offset: 262140,
    nextOffset: 262150,
    content: "abcdefghij",
    hasDecodingErrors: false,
    needsExactConfirmation: false,
  };
  const edit = createFilesLargeTextEditState("v1", 1_000_000);
  edit.changes.push({
    blockIndex: 1,
    offset: 262140,
    deleteBytes: 10,
    originalText: "abcdefghij",
    text: "edited",
  });

  const applied = resolveFilesLargeTextBlockProjection({ block, edit, version: "v1" });
  assert.equal(applied.content, "edited");
  assert.equal(applied.editable, true);
  assert.equal(applied.dirty, true);
  assert.equal(applied.applied, true);

  // 基准版本不同：不套用旧补丁，也不允许继续编辑。
  const staleVersion = resolveFilesLargeTextBlockProjection({ block, edit, version: "v2" });
  assert.equal(staleVersion.content, "abcdefghij");
  assert.equal(staleVersion.editable, false);

  // 原块正文变化：坐标失配，保持磁盘原块只读。
  const changedOriginal = resolveFilesLargeTextBlockProjection({
    block: { ...block, content: "different!" },
    edit,
    version: "v1",
  });
  assert.equal(changedOriginal.content, "different!");
  assert.equal(changedOriginal.editable, false);
  assert.equal(changedOriginal.applied, false);

  // 非法 UTF-8 / 待精确复核块只读，但不影响同 buffer 的其它块。
  const invalid = resolveFilesLargeTextBlockProjection({
    block: { ...block, hasDecodingErrors: true },
    edit,
    version: "v1",
  });
  assert.equal(invalid.editable, false);
  const unconfirmed = resolveFilesLargeTextBlockProjection({
    block: { ...block, needsExactConfirmation: true },
    edit,
    version: "v1",
  });
  assert.equal(unconfirmed.editable, false);
});

test("大文本 Monaco 模型 URI 按视图实例与 revision 隔离，多分屏同窗口不撞 URI", () => {
  const base = { bufferId: "large:workspace:path", revision: 3 };
  const firstSplit = filesLargeTextWindowModelUri({ ...base, instanceId: ":r0:" });
  const secondSplit = filesLargeTextWindowModelUri({ ...base, instanceId: ":r1:" });
  const nextWindow = filesLargeTextWindowModelUri({ ...base, instanceId: ":r0:", revision: 4 });

  assert.match(firstSplit, /^inmemory:\/\/files-large-text\//);
  assert.notEqual(firstSplit, secondSplit);
  assert.notEqual(firstSplit, nextWindow);
  // 两个分屏共享同一 buffer / window / revision 时仍必须得到不同模型 URI。
  assert.equal(new Set([firstSplit, secondSplit]).size, 2);
  // useId 等实例标识里的分隔符要被编码，不能改变 URI 结构。
  assert.doesNotMatch(firstSplit, /:r0:/);
});

test("未进入文件视图时 GroupPane 不挂载大文件 viewer，避免额外读盘与监视", () => {
  const buffer = largeBuffer();
  const markup = render(
    createElement(FilesEditorGroupPane, { ...groupProps(buffer), hasEnteredFiles: false }),
  );
  assert.doesNotMatch(markup, /data-files-large-text-viewer/);
});

test("FilesEditorGroupPane 在文本分支前接大文件只读 viewer，且不显示旧状态栏", () => {
  const buffer = largeBuffer();
  const markup = render(createElement(FilesEditorGroupPane, groupProps(buffer)));
  assert.match(markup, /data-files-large-text-viewer=""/);
  assert.match(
    markup,
    new RegExp(`data-buffer-id="${buffer.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
  );
  assert.doesNotMatch(markup, /filesWorkbench\.loadingFile|正在加载文件/);
  assert.doesNotMatch(markup, /files-editor-status-bar/);
  assert.doesNotMatch(markup, /filesWorkbench\.loadFileError|文件加载失败/);
});

test("大文件编辑区上方接外部变更提示，删除提示不提供重新加载", () => {
  const changedMarkup = render(
    createElement(
      FilesEditorGroupPane,
      groupProps({ ...largeBuffer(), externalChange: { kind: "changed" } }),
    ),
  );
  assert.match(changedMarkup, /data-files-external-change="changed"/);
  assert.match(changedMarkup, />重新加载</);
  assert.match(changedMarkup, />保留草稿</);
  // 大文件仍不显示普通全文件行号状态栏，提示条独立于编辑区。
  assert.doesNotMatch(changedMarkup, /files-editor-status-bar/);

  const deletedMarkup = render(
    createElement(
      FilesEditorGroupPane,
      groupProps({
        ...largeBuffer(),
        externalChange: { kind: "deleted", observedVersion: null },
      }),
    ),
  );
  assert.match(deletedMarkup, /data-files-external-change="deleted"/);
  assert.doesNotMatch(deletedMarkup, />重新加载</);
  assert.match(deletedMarkup, />保留草稿</);
});
