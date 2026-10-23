import assert from "node:assert/strict";
import test from "node:test";
import {
  useWorkspaceFileActionStore,
  type WorkspaceFileClipboardInput,
} from "../src/store/workspaceFileActionStore.js";
import {
  canPasteWorkspaceFile,
  canRunWorkspaceFileAction,
  getWorkspaceFileActionKey,
  getWorkspaceFileNameError,
  type WorkspaceFileAction,
} from "../src/workspace-file-tree/fileActionRules.js";

const source: WorkspaceFileClipboardInput = {
  operation: "copy",
  workspacePath: "/workspace",
  path: "/workspace/src",
  type: "directory",
  name: "src",
};

test("文件剪贴板只接受同工作区、同远程会话的粘贴", () => {
  const target = { workspacePath: "/workspace", path: "/workspace/dest" };
  assert.equal(canPasteWorkspaceFile(null, target), false);
  assert.equal(canPasteWorkspaceFile(source, target), true);
  assert.equal(canPasteWorkspaceFile(source, { ...target, workspacePath: "/other" }), false);
  assert.equal(canPasteWorkspaceFile({ ...source, remoteSessionId: "session-a" }, target), false);
  assert.equal(
    canPasteWorkspaceFile(
      { ...source, remoteSessionId: "session-a" },
      { ...target, remoteSessionId: "session-b" },
    ),
    false,
  );
  assert.equal(
    canPasteWorkspaceFile(
      { ...source, workspaceIdentity: " host:workspace ", remoteSessionId: "session-a" },
      {
        ...target,
        workspacePath: "/another-mount",
        workspaceIdentity: "host:workspace",
        remoteSessionId: "session-a",
      },
    ),
    true,
  );
  assert.equal(
    canPasteWorkspaceFile(
      { ...source, workspaceIdentity: "host:a" },
      { ...target, workspaceIdentity: "host:b" },
    ),
    false,
  );
});

test("目录不能粘贴进自身或后代，同名路径前缀不误判为子目录", () => {
  for (const path of ["/workspace/src", "/workspace/src/", "/workspace/src/deep"]) {
    assert.equal(canPasteWorkspaceFile(source, { workspacePath: "/workspace", path }), false);
  }
  assert.equal(
    canPasteWorkspaceFile(source, { workspacePath: "/workspace", path: "/workspace/src-other" }),
    true,
  );
  assert.equal(
    canPasteWorkspaceFile(source, {
      workspacePath: "/workspace",
      path: "/workspace/other/../src/deep",
    }),
    false,
  );
});

test("同父目录允许复制和剪切，由 Host 决定副本命名及移动无操作", () => {
  for (const operation of ["copy", "cut"] as const) {
    assert.equal(
      canPasteWorkspaceFile(
        { ...source, operation },
        { workspacePath: "/workspace", path: "/workspace" },
      ),
      true,
    );
  }
  assert.equal(
    canPasteWorkspaceFile(
      { ...source, path: "/workspace/readme.md", type: "file" },
      { workspacePath: "/workspace", path: "/workspace" },
    ),
    true,
  );
});

test("Windows 路径分隔符、大小写及 UNC 路径不会绕过目录自嵌套限制", () => {
  const windowsSource = { ...source, workspacePath: "C:\\work", path: "C:\\work\\src" };
  assert.equal(
    canPasteWorkspaceFile(windowsSource, { workspacePath: "C:\\work", path: "c:/WORK/SRC/deep" }),
    false,
  );
  assert.equal(
    canPasteWorkspaceFile(windowsSource, {
      workspacePath: "C:\\work",
      path: "C:\\work\\src-other",
    }),
    true,
  );
  const uncSource = { ...source, path: "\\\\server\\share\\src" };
  assert.equal(
    canPasteWorkspaceFile(uncSource, {
      workspacePath: "/workspace",
      path: "//SERVER/share/SRC/deep",
    }),
    false,
  );
});

test("名称保留合法单名称，拒绝空、路径、平台非法字符及 Windows 保留名", () => {
  for (const name of ["", " ", "\t"]) {
    assert.equal(getWorkspaceFileNameError(name), "empty");
  }
  for (const name of [
    ".",
    "..",
    "a/b",
    "a\\b",
    "a:b",
    "a<b",
    "a>b",
    'a"b',
    "a|b",
    "a?b",
    "a*b",
    "file.",
    "file ",
    "file\n",
    "file\0",
    "CON",
    "con.txt",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "com9.log",
    "LPT1",
    "LPT9.txt",
    "COM¹.txt",
  ]) {
    assert.equal(getWorkspaceFileNameError(name), "invalid", name);
  }
  for (const name of ["index.ts", ".env", "目录", " file", "COM10", "LPT0", "console.txt"]) {
    assert.equal(getWorkspaceFileNameError(name), null, name);
  }
});

test("工作区 key 优先身份且隔离远程会话，不因字段包含分隔符而碰撞", () => {
  const workspace = { workspacePath: "/workspace", workspaceIdentity: " identity " };
  assert.equal(
    getWorkspaceFileActionKey(workspace),
    getWorkspaceFileActionKey({ workspacePath: "/elsewhere", workspaceIdentity: "identity" }),
  );
  assert.equal(
    getWorkspaceFileActionKey({ workspacePath: "/workspace", workspaceIdentity: " " }),
    getWorkspaceFileActionKey({ workspacePath: "/workspace" }),
  );
  assert.notEqual(
    getWorkspaceFileActionKey({ ...workspace, remoteSessionId: "a" }),
    getWorkspaceFileActionKey({ ...workspace, remoteSessionId: "b" }),
  );
  assert.notEqual(
    getWorkspaceFileActionKey({ workspacePath: "a\0b", remoteSessionId: "c" }),
    getWorkspaceFileActionKey({ workspacePath: "a", remoteSessionId: "b\0c" }),
  );
});

test("完成旧剪切不会清掉操作期间新复制的剪贴板", () => {
  const store = useWorkspaceFileActionStore;
  store.setState({ clipboard: null, busyWorkspaceKeys: [] });
  const firstId = store.getState().setClipboard({ ...source, operation: "cut" });
  const secondId = store
    .getState()
    .setClipboard({ ...source, path: "/workspace/second", name: "second" });
  assert.notEqual(firstId, secondId);
  store.getState().clearClipboard(firstId);
  assert.equal(store.getState().clipboard?.id, secondId);
  store.getState().clearClipboard(secondId);
  assert.equal(store.getState().clipboard, null);
  store.getState().clearClipboard(secondId);
  store.getState().setClipboard(source);
  store.getState().clearClipboard();
  assert.equal(store.getState().clipboard, null);
});

test("同工作区变更同步准入一次，不同工作区可独立执行，结束幂等", () => {
  const store = useWorkspaceFileActionStore;
  store.setState({ clipboard: null, busyWorkspaceKeys: [] });
  const keyA = getWorkspaceFileActionKey({ workspacePath: "/a" });
  const keyB = getWorkspaceFileActionKey({ workspacePath: "/b" });
  assert.equal(store.getState().beginOperation(keyA), true);
  assert.equal(store.getState().beginOperation(keyA), false);
  assert.equal(store.getState().beginOperation(keyB), true);
  assert.deepEqual(store.getState().busyWorkspaceKeys, [keyA, keyB]);
  store.getState().endOperation(keyA);
  store.getState().endOperation(keyA);
  assert.deepEqual(store.getState().busyWorkspaceKeys, [keyB]);
  assert.equal(store.getState().beginOperation(keyA), true);
  store.getState().endOperation(keyA);
  store.getState().endOperation(keyB);
  assert.deepEqual(store.getState().busyWorkspaceKeys, []);
});

const actions: WorkspaceFileAction[] = [
  "create-file",
  "create-directory",
  "rename",
  "delete",
  "copy",
  "cut",
  "paste",
];
const availableOptions = {
  workspace: { workspacePath: "/workspace" },
  rpcReady: true,
  readOnly: false,
  temporaryExternalDirectory: false,
  busy: false,
  clipboard: { ...source, path: "/workspace/original.ts", type: "file" as const },
};

test("文件和目录的菜单仅启用各自可执行的操作，根目录保留新建和粘贴", () => {
  const file = { path: "/workspace/a.ts", type: "file" as const };
  const directory = { path: "/workspace/src", type: "directory" as const };
  const root = { path: "/workspace", type: "directory" as const, root: true };
  for (const action of actions) {
    assert.equal(
      canRunWorkspaceFileAction(action, file, availableOptions),
      !["create-file", "create-directory", "paste"].includes(action),
      action,
    );
    assert.equal(canRunWorkspaceFileAction(action, directory, availableOptions), true, action);
    assert.equal(
      canRunWorkspaceFileAction(action, root, availableOptions),
      ["create-file", "create-directory", "paste"].includes(action),
      action,
    );
  }
});

test("只读工作区允许复制，断线、执行中、临时外部目录和deleted行禁用全部文件操作", () => {
  const directory = { path: "/workspace/src", type: "directory" as const };
  for (const action of actions) {
    assert.equal(
      canRunWorkspaceFileAction(action, directory, { ...availableOptions, readOnly: true }),
      action === "copy",
      action,
    );
    for (const unavailable of [
      { rpcReady: false },
      { busy: true },
      { temporaryExternalDirectory: true },
    ]) {
      assert.equal(
        canRunWorkspaceFileAction(action, directory, { ...availableOptions, ...unavailable }),
        false,
        action,
      );
    }
    assert.equal(
      canRunWorkspaceFileAction(action, { ...directory, deleted: true }, availableOptions),
      false,
      action,
    );
  }
});

test("菜单粘贴准入复用剪贴板工作区、会话及目录边界规则", () => {
  const directory = { path: "/workspace/src", type: "directory" as const };
  assert.equal(
    canRunWorkspaceFileAction("paste", directory, { ...availableOptions, clipboard: null }),
    false,
  );
  assert.equal(
    canRunWorkspaceFileAction("paste", directory, {
      ...availableOptions,
      workspace: { workspacePath: "/other" },
    }),
    false,
  );
  assert.equal(
    canRunWorkspaceFileAction("paste", directory, {
      ...availableOptions,
      workspace: { workspacePath: "/workspace", remoteSessionId: "other" },
    }),
    false,
  );
  assert.equal(
    canRunWorkspaceFileAction("paste", directory, {
      ...availableOptions,
      clipboard: source,
    }),
    false,
  );
  assert.equal(
    canRunWorkspaceFileAction(
      "paste",
      { ...directory, path: "/workspace/src/deep" },
      {
        ...availableOptions,
        clipboard: source,
      },
    ),
    false,
  );
});
