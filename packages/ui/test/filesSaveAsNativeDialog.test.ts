import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseFilesSaveAsNativeDialog,
  FilesSaveAsNativeDialogController,
} from "../src/files-workbench/filesSaveAsNativeDialog.js";
import { filesSaveAsDefaultPath } from "../src/files-workbench/filesSaveAsPath.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("只有本机目标、声明可返回本机路径且提供原生方法时才启用系统对话框", () => {
  const complete = {
    canSelectFilePath: true,
    showSaveDialog: async () => null,
  };
  assert.equal(canUseFilesSaveAsNativeDialog({ allowNativePath: true, platform: complete }), true);

  const cases = [
    { allowNativePath: false, platform: complete },
    { allowNativePath: true, platform: null },
    { allowNativePath: true, platform: undefined },
    { allowNativePath: true, platform: { ...complete, canSelectFilePath: false } },
    { allowNativePath: true, platform: { canSelectFilePath: true } },
    { allowNativePath: true, platform: { canSelectFilePath: true, showSaveDialog: null } },
  ];
  for (const params of cases) {
    assert.equal(
      canUseFilesSaveAsNativeDialog(
        params as unknown as Parameters<typeof canUseFilesSaveAsNativeDialog>[0],
      ),
      false,
    );
  }
});

test("默认路径覆盖 Windows 盘符、根目录、反斜杠与 POSIX 路径", () => {
  assert.equal(
    filesSaveAsDefaultPath("C:\\Users\\me\\docs", "notes.txt"),
    "C:\\Users\\me\\docs\\notes.txt",
  );
  assert.equal(filesSaveAsDefaultPath("C:\\", "notes.txt"), "C:\\notes.txt");
  assert.equal(filesSaveAsDefaultPath("/home/me", "notes.txt"), "/home/me/notes.txt");
  assert.equal(filesSaveAsDefaultPath("/", "notes.txt"), "/notes.txt");
  assert.equal(filesSaveAsDefaultPath("/home/me/", "notes.txt"), "/home/me/notes.txt");
  assert.equal(filesSaveAsDefaultPath("/home/me", "notes.txt"), "/home/me/notes.txt");
});

test("文件名为空时只使用当前目录，文件名原样进入默认路径", () => {
  assert.equal(filesSaveAsDefaultPath("/home/me", ""), "/home/me");
  assert.equal(filesSaveAsDefaultPath("", "notes.txt"), "notes.txt");
  assert.equal(filesSaveAsDefaultPath("", ""), undefined);
  assert.equal(filesSaveAsDefaultPath("/home/me", "my notes.txt"), "/home/me/my notes.txt");
  assert.equal(filesSaveAsDefaultPath("/home/me", "../escape.txt"), "/home/me");
});

test("请求中重复触发不会打开第二个系统对话框", async () => {
  const pending = deferred<string | null>();
  let calls = 0;
  const controller = new FilesSaveAsNativeDialogController();
  const show = (): Promise<string | null> => {
    calls += 1;
    return pending.promise;
  };

  const first = controller.run(show, { defaultPath: "/a.txt" });
  const second = controller.run(show, { defaultPath: "/b.txt" });
  assert.deepEqual(await second, { kind: "ignored" });
  assert.equal(controller.pending, true);
  pending.resolve("/picked.txt");
  assert.deepEqual(await first, { kind: "path", path: "/picked.txt" });
  assert.equal(calls, 1);
  assert.equal(controller.pending, false);
});

test("原生取消保留弹窗且不产生路径；异常返回失败结果并允许重试", async () => {
  const controller = new FilesSaveAsNativeDialogController();
  assert.deepEqual(await controller.run(async () => null, {}), { kind: "cancelled" });
  assert.equal(controller.pending, false);
  assert.deepEqual(
    await controller.run(async () => {
      throw new Error("dialog-broken");
    }, {}),
    { kind: "error" },
  );
  assert.equal(controller.pending, false);
  assert.deepEqual(await controller.run(async () => "/retry.txt", {}), {
    kind: "path",
    path: "/retry.txt",
  });
});

test("关闭/更换目标后的迟到路径和旧错误作废，且不影响新请求", async () => {
  const controller = new FilesSaveAsNativeDialogController();
  const first = deferred<string | null>();
  const second = deferred<string | null>();
  let calls = 0;
  const show = (): Promise<string | null> => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  };

  const stalePath = controller.run(show, { defaultPath: "/old.txt" });
  controller.invalidate();
  const fresh = controller.run(show, { defaultPath: "/new.txt" });
  assert.equal(calls, 2);
  assert.equal(controller.pending, true);

  // 旧请求迟到：结果作废，且不能把新请求的 pending 提前清掉。
  first.resolve("/late-old.txt");
  assert.deepEqual(await stalePath, { kind: "ignored" });
  assert.equal(controller.pending, true);

  second.resolve("/fresh.txt");
  assert.deepEqual(await fresh, { kind: "path", path: "/fresh.txt" });
  assert.equal(controller.pending, false);

  assert.deepEqual(
    await controller.run(async () => {
      throw new Error("new-target-error");
    }, {}),
    { kind: "error" },
  );
});
