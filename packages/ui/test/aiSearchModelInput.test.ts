import assert from "node:assert/strict";
import test from "node:test";
import { resolveAiSearchModelInput } from "../src/command-center/aiSearchModelInput.js";

// 命令中心 AI 搜索模型输入（docs/specs/composer-displayed-model.md）：
// 优先工作区“最后展示的模型”，缺失才退最近一次 accepted 发送偏好。

test("有最后展示记录时优先使用它", () => {
  const displayed = { providerId: "p1", modelId: "m-displayed" };
  const recent = { providerId: "p1", modelId: "m-recent" };
  assert.deepEqual(resolveAiSearchModelInput(displayed, recent), { selection: displayed });
});

test("记录缺失/坏数据时退回最近提交偏好", () => {
  const recent = { providerId: "p1", modelId: "m-recent" };
  assert.deepEqual(resolveAiSearchModelInput(null, recent), { selection: recent });
  assert.deepEqual(resolveAiSearchModelInput(undefined, recent), { selection: recent });
});

test("两者都没有时不带 input（沿既有 preferred/CLI 回退）", () => {
  assert.equal(resolveAiSearchModelInput(null, null), undefined);
  assert.equal(resolveAiSearchModelInput(undefined, undefined), undefined);
});
