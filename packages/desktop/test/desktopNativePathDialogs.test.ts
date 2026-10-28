import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// 主进程原生选路 IPC：electron 桩垫 dialog/BrowserWindow/ipcMain，
// 直接调用注册后的 handler，验证父窗口、参数边界、取消语义与“只选路径不写盘”。
import { PlatformChannels } from "@zcode/shared";
import {
  __clearDialogCalls,
  __clearIpcHandlers,
  __dialogCalls,
  __getIpcHandler,
  __setOpenDialogResult,
  __setSaveDialogResult,
  __setWindows,
} from "./helpers/electronStub.mjs";
import { registerDesktopNativePathDialogIpcHandlers } from "../src/main/desktopNativePathDialogs.js";

const senderEvent = { sender: { id: 7 } };

function registerHandlers() {
  __clearIpcHandlers();
  __clearDialogCalls();
  __setWindows([7]);
  registerDesktopNativePathDialogIpcHandlers();
}

test("目录、单文件、多文件选择透传默认路径与标题，并以发起窗口为父", async () => {
  registerHandlers();
  __setOpenDialogResult({ canceled: false, filePaths: ["C:\\work\\src"] });

  const selectDirectory = __getIpcHandler(PlatformChannels.SelectDirectory);
  const selected = await selectDirectory(senderEvent, {
    defaultPath: "C:\\work",
    title: "选择目录",
  });

  assert.equal(selected, "C:\\work\\src");
  const directoryCall = __dialogCalls[0];
  assert.equal(directoryCall?.kind, "open");
  assert.equal(directoryCall?.args.length, 2);
  assert.equal(directoryCall?.args[0]?.id, 7);
  assert.deepEqual(directoryCall?.args[1], {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: "C:\\work",
    title: "选择目录",
  });

  __clearDialogCalls();
  __setOpenDialogResult({ canceled: false, filePaths: ["/tmp/a.txt"] });
  const selectFile = __getIpcHandler(PlatformChannels.SelectFile);
  assert.equal(await selectFile(senderEvent, { defaultPath: "/tmp" }), "/tmp/a.txt");
  assert.deepEqual(__dialogCalls[0]?.args[1], {
    properties: ["openFile"],
    defaultPath: "/tmp",
  });

  __clearDialogCalls();
  __setOpenDialogResult({ canceled: false, filePaths: ["/tmp/a.txt", "/tmp/b.txt"] });
  const selectFiles = __getIpcHandler(PlatformChannels.SelectFiles);
  assert.deepEqual(await selectFiles(senderEvent, { title: "选择文件" }), [
    "/tmp/a.txt",
    "/tmp/b.txt",
  ]);
  assert.deepEqual(__dialogCalls[0]?.args[1], {
    properties: ["openFile", "multiSelections"],
    title: "选择文件",
  });
});

test("取消时目录/文件返回 null，多选返回空数组；无参数调用保持兼容", async () => {
  registerHandlers();
  __setOpenDialogResult({ canceled: true, filePaths: [] });

  const selectDirectory = __getIpcHandler(PlatformChannels.SelectDirectory);
  const selectFile = __getIpcHandler(PlatformChannels.SelectFile);
  const selectFiles = __getIpcHandler(PlatformChannels.SelectFiles);

  assert.equal(await selectDirectory(senderEvent), null);
  assert.equal(await selectFile(senderEvent), null);
  assert.deepEqual(await selectFiles(senderEvent), []);
  // 旧的无参调用不带 options，对话框不应出现空的 defaultPath/title 字段。
  assert.deepEqual(__dialogCalls[0]?.args[1], {
    properties: ["openDirectory", "createDirectory"],
  });
});

test("保存选路只返回路径，不写入文件；取消返回 null", async () => {
  registerHandlers();
  __setSaveDialogResult({ canceled: false, filePath: "D:\\out\\note.md" });

  const showSaveDialog = __getIpcHandler(PlatformChannels.ShowSaveDialog);
  assert.equal(
    await showSaveDialog(senderEvent, {
      defaultPath: "C:\\work\\note.md",
      title: "另存为",
    }),
    "D:\\out\\note.md",
  );
  assert.equal(__dialogCalls[0]?.kind, "save");
  assert.equal(__dialogCalls[0]?.args[0]?.id, 7);
  assert.deepEqual(__dialogCalls[0]?.args[1], {
    defaultPath: "C:\\work\\note.md",
    title: "另存为",
  });

  __clearDialogCalls();
  __setSaveDialogResult({ canceled: true, filePath: undefined });
  assert.equal(await showSaveDialog(senderEvent), null);
  assert.deepEqual(__dialogCalls[0]?.args[1], {});

  const source = readFileSync(
    new URL("../src/main/desktopNativePathDialogs.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /writeFile|copyFile|writeTextFile|mkdtemp/);
});

test("参数类型或字符串边界非法时拒绝，不打开系统对话框", async () => {
  registerHandlers();
  const selectDirectory = __getIpcHandler(PlatformChannels.SelectDirectory);
  const showSaveDialog = __getIpcHandler(PlatformChannels.ShowSaveDialog);

  for (const invalid of [
    "not-an-object",
    null,
    [],
    { defaultPath: 42 },
    { defaultPath: "" },
    { defaultPath: "   " },
    { defaultPath: "x".repeat(4_097) },
    { title: {} },
    { title: " \t\n " },
    { title: "x".repeat(201) },
  ]) {
    await assert.rejects(() => selectDirectory(senderEvent, invalid), {
      message: "invalid_native_dialog_options",
    });
  }
  await assert.rejects(() => showSaveDialog(senderEvent, { title: 1 }), {
    message: "invalid_native_dialog_options",
  });
  assert.equal(__dialogCalls.length, 0);
});

test("旧 preload 缺少 showSaveDialog 时 bridge 保持 undefined，新 preload 透传 options 与结果", async () => {
  const globalScope = globalThis as typeof globalThis & { window?: unknown };
  const originalWindow = globalScope.window;
  try {
    globalScope.window = { zcode: {} };
    const legacyBridge =
      await import("../src/renderer/src/desktopBrowserPlatformBridge.js?legacy-preload");
    assert.equal(legacyBridge.desktopBrowserPlatformBridge.showSaveDialog, undefined);

    const calls: unknown[] = [];
    const results: (string | null)[] = ["D:\\out\\note.md", null];
    globalScope.window = {
      zcode: {
        showSaveDialog: async (options?: unknown) => {
          calls.push(options);
          return results.shift() ?? null;
        },
      },
    };
    const currentBridge =
      await import("../src/renderer/src/desktopBrowserPlatformBridge.js?current-preload");
    const options = { defaultPath: "C:\\work\\note.md", title: "另存为" };
    assert.equal(
      await currentBridge.desktopBrowserPlatformBridge.showSaveDialog?.(options),
      "D:\\out\\note.md",
    );
    assert.equal(await currentBridge.desktopBrowserPlatformBridge.showSaveDialog?.(), null);
    assert.deepEqual(calls, [options, undefined]);
  } finally {
    if (originalWindow === undefined) {
      delete globalScope.window;
    } else {
      globalScope.window = originalWindow;
    }
  }
});
