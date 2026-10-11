import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChatEmptyWorkspaceCreateDialog,
  getScratchWorkspaceLocationHint,
  getScratchWorkspaceNameErrorKind,
} from "../src/ChatEmptyScratchWorkspaceDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

/**
 * 「从空目录开始」新建工作区：名称校验、落点提示、对话框关闭态，
 * 以及空态菜单到壳层的接线——该入口此前因 onCreateScratchWorkspace
 * 只被透传、没有渲染 UI 而整块缺失，这里用源码断言钉住接线不再断开。
 */

const menuSource = readFileSync(new URL("../src/ChatEmptyState.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(
  new URL("../src/app-shell/WorkspaceShellLayout.tsx", import.meta.url),
  "utf8",
);
const zhCnSource = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUsSource = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

test("名称校验：空名与路径分隔符被拒绝，其余放行", () => {
  assert.equal(getScratchWorkspaceNameErrorKind(""), "required");
  assert.equal(getScratchWorkspaceNameErrorKind("   "), "required");
  assert.equal(getScratchWorkspaceNameErrorKind("a/b"), "separator");
  assert.equal(getScratchWorkspaceNameErrorKind("a\\b"), "separator");
  assert.equal(getScratchWorkspaceNameErrorKind("my-app"), null);
});

test("落点提示固定为 ~/YCodeProject/<名称>，去掉首尾空格", () => {
  assert.equal(getScratchWorkspaceLocationHint("my-app"), "~/YCodeProject/my-app");
  assert.equal(getScratchWorkspaceLocationHint("  my-app  "), "~/YCodeProject/my-app");
});

test("对话框关闭态零渲染：不挂载 Portal、无 DOM 输出", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      null,
      createElement(ChatEmptyWorkspaceCreateDialog, {
        open: false,
        onOpenChange: () => {},
        onCreate: async () => null,
      }),
    ),
  );
  assert.equal(markup, "");
});

test("空态菜单入口存在，且壳层已把它接到 onCreateScratchWorkspace", () => {
  assert.ok(menuSource.includes("onCreateWorkspace"), "菜单必须接收 onCreateWorkspace prop");
  assert.ok(
    menuSource.includes("workspace.startFromScratch"),
    "菜单项必须使用「从空目录开始」文案",
  );
  assert.ok(
    shellSource.includes("onCreateWorkspace={onCreateScratchWorkspace}"),
    "壳层必须把 onCreateScratchWorkspace 接入菜单，避免 prop 悬空",
  );
});

test("中英文语言包都保留创建工作区文案", () => {
  for (const id of [
    "chat.empty.createWorkspace.title",
    "chat.empty.createWorkspace.placeholder",
    "chat.empty.createWorkspace.locationHint",
    "chat.empty.createWorkspace.confirm",
    "chat.empty.createWorkspace.error.required",
    "chat.empty.createWorkspace.error.separator",
    "chat.empty.createWorkspace.error.createFailed",
  ]) {
    assert.ok(zhCnSource.includes(`"${id}"`), `zh-CN 缺少文案：${id}`);
    assert.ok(enUsSource.includes(`"${id}"`), `en-US 缺少文案：${id}`);
  }
});
