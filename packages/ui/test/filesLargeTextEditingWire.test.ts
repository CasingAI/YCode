import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filesActiveSavableBuffer } from "../src/files-workbench/filesActiveSavableBuffer.js";
import {
  createLargeTextFileBuffer,
  createPreviewBuffer,
  createTextFileBuffer,
} from "../src/files-workbench/filesEditorModel.js";
import { createFilesLargeTextEditState } from "../src/files-workbench/filesLargeTextDraftModel.js";

/**
 * 大文件编辑 + 多端外部修改的 UI 接线契约。
 *
 * 行为 owner 仍是 Files Editor Store / controller：这里只锁定界面层是否把
 * saveToken、外部变更、草稿状态和另存为入口接到正确的投影与回调上。
 */

const workspace = { workspacePath: "/workspace" };

function source(relative: string): string {
  return readFileSync(new URL(`../src/files-workbench/${relative}`, import.meta.url), "utf8");
}

const surfaceSource = source("FilesWorkbenchSurface.tsx");
const groupPaneSource = source("FilesEditorGroupPane.tsx");
const contentSource = source("FilesEditorContent.tsx");
const viewerSource = source("FilesLargeTextViewer.tsx");
const saveAsSource = source("FilesWorkbenchSaveAsDialog.tsx");
const dialogsSource = source("FilesWorkbenchDialogs.tsx");
const draftStatusSource = source("FilesLargeTextDraftStatus.tsx");

test("Surface 首次进入后保持持久化 owner，watch 仍跟随可见状态", () => {
  assert.match(surfaceSource, /useFilesWorkbenchController\(hasEnteredFiles, isActiveView\)/);
});

test("Surface 另存为使用可保存缓冲，覆盖完整文本与大文件", () => {
  assert.match(surfaceSource, /filesActiveSavableBuffer\(buffers, controller\.saveAsBufferId\)/);
  assert.doesNotMatch(surfaceSource, /filesActiveTextBuffer/);
});

test("Surface 挂载大文件冲突、外部重载确认与草稿状态提示", () => {
  assert.match(surfaceSource, /<FilesLargeTextConflictDialog[\s\S]*?handleLargeConflictDecision/);
  assert.match(
    surfaceSource,
    /<FilesExternalChangeReloadDialog[\s\S]*?handleExternalReloadDecision/,
  );
  assert.match(surfaceSource, /<FilesLargeTextDraftStatus/);
});

test("草稿 blocked / error 可显式重试，放弃只能经确认回调", () => {
  assert.match(draftStatusSource, /restoreOnActivate\(bufferId\)/);
  assert.match(draftStatusSource, /discardBlockedDraft\(bufferId\)/);
  // 放弃入口只由确认弹窗触发；状态提示不做静默删除。
  assert.doesNotMatch(draftStatusSource, /(?:useEffect|onMount)[\s\S]{0,200}discardBlockedDraft/);
});

test("GroupPane 把外部变更 banner 与重载 / 保留回调接在编辑区上方", () => {
  assert.match(groupPaneSource, /<FilesEditorExternalChangeBanner/);
  assert.match(
    groupPaneSource,
    /onReload=\{\(\) => editorBuffer && onExternalChangeAction\(editorBuffer\.id, "reload"\)\}/,
  );
  assert.match(
    groupPaneSource,
    /onKeep=\{\(\) => editorBuffer && onExternalChangeAction\(editorBuffer\.id, "dismiss"\)\}/,
  );
  assert.match(surfaceSource, /controller\.requestReloadBuffer\(bufferId\)/);
  assert.match(surfaceSource, /controller\.dismissExternalChange\(bufferId\)/);
});

test("大文件菜单句柄与大文件刷新确认独立接线，但不显示普通全文件状态栏", () => {
  // 内容区分支已拆到 FilesEditorContent：组外壳只负责把句柄与外部变更动作传下去。
  assert.match(groupPaneSource, /onStatusHandleChange=\{onStatusHandleChange\}/);
  assert.match(groupPaneSource, /onExternalChangeAction=\{onExternalChangeAction\}/);
  assert.match(contentSource, /onEditorStatusHandleChange=\{onStatusHandleChange\}/);
  assert.match(
    contentSource,
    /onReloadRequested=\{\(\) => onExternalChangeAction\(buffer\.id, "reload"\)\}/,
  );
  // 状态栏仍只读取普通文本的 statusHandle / statusState，大文件标签显式隐藏。
  assert.match(
    groupPaneSource,
    /\{activeBuffer\?\.kind !== "large-text" && statusHandle && statusState \? \(/,
  );
});

test("保存期间大文件编辑器只读、显示 saving 且刷新不能丢稿", () => {
  assert.match(viewerSource, /const saving = Boolean\(buffer\.saveToken\);/);
  assert.match(viewerSource, /const editorEditable = editable && !saving;/);
  assert.match(viewerSource, /editable=\{editorEditable\}/);
  assert.match(viewerSource, /data-files-large-text-saving=""/);
  assert.match(viewerSource, /filesWorkbench\.largeText\.saving/);
  assert.match(viewerSource, /if \(saving\) return;/);
  assert.match(viewerSource, /disabled=\{saving\}/);
  // 脏草稿刷新仍先走外部确认，不直接把补丁套到新基准。
  assert.match(viewerSource, /if \(dirty\) \{[\s\S]*?onReloadRequested\?\.\(\);/);
});

test("大文件另存复用现有原生路径对话框，不新增第二套路径选择", () => {
  assert.match(saveAsSource, /saveAsBuffer\?: FilesBuffer;/);
  assert.match(saveAsSource, /controller\.saveTextBuffer\(saveAsBuffer, \{ path, force: true \}\)/);
});

test("删除后的普通冲突只提供重新创建；大文件冲突只允许取消或丢弃重载", () => {
  assert.match(dialogsSource, /\{!deleted && \([\s\S]*?onDecide\("reload"\)/);
  assert.match(
    dialogsSource,
    /id: deleted \? "filesWorkbench\.conflictRecreate" : "filesWorkbench\.conflictOverwrite"/,
  );

  const largeConflict = dialogsSource.slice(
    dialogsSource.indexOf("export function FilesLargeTextConflictDialog"),
    dialogsSource.indexOf("export function FilesExternalChangeReloadDialog"),
  );
  assert.doesNotMatch(largeConflict, /onDecide\("overwrite"\)/);
  assert.match(largeConflict, /onDecide\("cancel"\)/);
  assert.match(largeConflict, /onDecide\("reload"\)/);
});

test("另存为只放行可保存的大文件与完整文本，预览和未读盘缓冲被排除", () => {
  const text = createTextFileBuffer({ workspace, path: "/workspace/a.txt", text: "a" });
  assert.equal(filesActiveSavableBuffer([text], text.id), text);

  const unloaded = { ...text, id: "unloaded", loadState: "unloaded" as const };
  assert.equal(filesActiveSavableBuffer([unloaded], unloaded.id), undefined);

  const preview = {
    ...createPreviewBuffer({ workspace, path: "/workspace/a.png" }),
    id: "preview",
  };
  assert.equal(filesActiveSavableBuffer([preview], "preview"), undefined);

  const large = createLargeTextFileBuffer({ workspace, path: "/workspace/huge.log" });
  assert.equal(filesActiveSavableBuffer([large], large.id), undefined);

  const editableLarge = { ...large, edit: createFilesLargeTextEditState("v1", 1024) };
  assert.equal(filesActiveSavableBuffer([editableLarge], large.id), editableLarge);
});
