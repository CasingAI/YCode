import assert from "node:assert/strict";
import test from "node:test";
import { toolCallBackgroundKind } from "../src/v4/toolCallBackgroundKind.js";

// 工具行「后台 / 转后台」措辞的判定。两种后台的差别只在「入参有没有显式后台标记」：
// 带 run_in_background 是调用时就要求后台，没带却是前台跑满 timeout 被运行时移交。
// 详见 docs/specs/tool-call-duration.md「后台移交」。

test("没有 backgrounded 的行不产出措辞，调用方按普通工具行走耗时分支", () => {
  assert.equal(toolCallBackgroundKind({}), undefined);
  assert.equal(
    toolCallBackgroundKind({ backgrounded: false, toolInput: { run_in_background: true } }),
    undefined,
  );
});

test("backgrounded + run_in_background: true → requested（「后台」）", () => {
  assert.equal(
    toolCallBackgroundKind({
      backgrounded: true,
      toolInput: { command: "sleep 180", run_in_background: true },
    }),
    "requested",
  );
});

test("backgrounded + 入参无标记 → auto（「转后台」）", () => {
  assert.equal(
    toolCallBackgroundKind({ backgrounded: true, toolInput: { command: "sleep 60" } }),
    "auto",
  );
});

test("background 也算显式标记（子代理事件的既有约定，将来有工具用它不必再改这里）", () => {
  assert.equal(toolCallBackgroundKind({ backgrounded: true, toolInput: { background: true } }), "requested");
});

test("标记为 false / 缺席 / 入参不是对象，都不误判成显式后台", () => {
  assert.equal(
    toolCallBackgroundKind({ backgrounded: true, toolInput: { run_in_background: false } }),
    "auto",
  );
  assert.equal(toolCallBackgroundKind({ backgrounded: true, toolInput: {} }), "auto");
  assert.equal(toolCallBackgroundKind({ backgrounded: true, toolInput: undefined }), "auto");
  assert.equal(toolCallBackgroundKind({ backgrounded: true, toolInput: "run_in_background" }), "auto");
  assert.equal(toolCallBackgroundKind({ backgrounded: true, toolInput: null }), "auto");
  assert.equal(
    toolCallBackgroundKind({ backgrounded: true, toolInput: [{ run_in_background: true }] }),
    "auto",
  );
});

test("标记只认 true：字符串/数字真值不算（避免模型传 1 就被当成显式后台）", () => {
  assert.equal(
    toolCallBackgroundKind({ backgrounded: true, toolInput: { run_in_background: 1 } }),
    "auto",
  );
  assert.equal(
    toolCallBackgroundKind({ backgrounded: true, toolInput: { run_in_background: "true" } }),
    "auto",
  );
});