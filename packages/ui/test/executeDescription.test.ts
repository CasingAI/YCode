import assert from "node:assert/strict";
import test from "node:test";
import { getExecuteDescription } from "../src/ToolCallBlocks/renderers/executeDescription.js";

// description 成为 Bash 必填参数后，卡片主文案依赖它；
// 旧会话（以及非对象形态的 input）没有这个字段，必须安全退化为 undefined。

test("getExecuteDescription：读取并 trim 命令用途摘要", () => {
  assert.equal(
    getExecuteDescription({ command: "ls -la", description: "  List files  " }),
    "List files",
  );
});

test("getExecuteDescription：缺失或空描述返回 undefined", () => {
  assert.equal(getExecuteDescription({ command: "ls -la" }), undefined);
  assert.equal(getExecuteDescription({ command: "ls -la", description: "   " }), undefined);
  assert.equal(getExecuteDescription({ command: "ls -la", description: 42 }), undefined);
});

test("getExecuteDescription：非对象输入不抛错", () => {
  assert.equal(getExecuteDescription(undefined), undefined);
  assert.equal(getExecuteDescription(null), undefined);
  assert.equal(getExecuteDescription("ls -la"), undefined);
  assert.equal(getExecuteDescription(["ls", "-la"]), undefined);
});
