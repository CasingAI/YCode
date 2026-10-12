import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchShellBinding } from "../src/v4/WorkbenchPane.js";

/**
 * 工作台叶子把壳回调下发给会话窗时，打开沙盒控制台必须和打开终端后台成对出现。
 * 漏掉前者时，状态面板会把「沙盒」整块卸掉，干净工作区右上角就是空的。
 */
test("工作台壳绑定把打开沙盒控制台列为与终端后台同级的回调", () => {
  const shell = {
    workspacePath: "/repo",
    sessionId: "sess_1",
    onOpenBackgroundBash: () => undefined,
    onOpenSandboxConsole: () => undefined,
  } satisfies Pick<
    WorkbenchShellBinding,
    "workspacePath" | "sessionId" | "onOpenBackgroundBash" | "onOpenSandboxConsole"
  >;
  assert.equal(typeof shell.onOpenBackgroundBash, "function");
  assert.equal(typeof shell.onOpenSandboxConsole, "function");
});
