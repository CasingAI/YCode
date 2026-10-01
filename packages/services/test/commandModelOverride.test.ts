import assert from "node:assert/strict";
import test from "node:test";
import { CommandFileParser } from "../src/commands/commandFileParser.js";

// 命令绑定模型（docs/specs/command-model-binding.md）的文件头读写边界：
// 设置页行内控件即改即存只改 model / model-effort 两个键，其余 frontmatter 与
// prompt 原样保留，删除绑定时不能留下空 frontmatter 块。

test("parse：model / model-effort 投影为 modelSelectionOverride", () => {
  const parsed = CommandFileParser.parseCommandFile(
    `---
description: 提交当前变更
model: openai/gpt-5
model-effort: high
---

请提交。`,
    "/users/me/.zcode/commands/commit.md",
  );
  assert.deepEqual(parsed?.modelSelectionOverride, {
    providerId: "openai",
    modelId: "gpt-5",
    options: { reasoningLevel: "high" },
  });
});

test("parse：坏 model 值按未绑定处理，不阻断其余字段", () => {
  const parsed = CommandFileParser.parseCommandFile(
    `---
description: 提交
model: gpt-5
---

请提交。`,
    "/users/me/.zcode/commands/commit.md",
  );
  assert.equal(parsed?.modelSelectionOverride, undefined);
  assert.equal(parsed?.description, "提交");
});

test("rewrite：只替换 model / model-effort，保留用户手写的其他键", () => {
  const existing = `---
description: 提交当前变更
allowed-tools: Bash, Edit
model: openai/gpt-5
---

请提交。`;
  const rewritten = CommandFileParser.rewriteModelFrontmatter(existing, {
    providerId: "zcode",
    modelId: "glm-5.3",
    options: { reasoningLevel: "medium" },
  });
  assert.deepEqual(
    CommandFileParser.parseCommandFile(rewritten, "/users/me/.zcode/commands/commit.md")
      ?.modelSelectionOverride,
    { providerId: "zcode", modelId: "glm-5.3", options: { reasoningLevel: "medium" } },
  );
  assert.match(rewritten, /allowed-tools: Bash, Edit/);
  assert.match(rewritten, /description: 提交当前变更/);
  assert.match(rewritten, /请提交。/);
  // 旧 model 行必须被替换而不是追加第二份。
  assert.doesNotMatch(rewritten, /openai\/gpt-5/);
});

test("rewrite：没有 frontmatter 的文件也能新增绑定", () => {
  const rewritten = CommandFileParser.rewriteModelFrontmatter("请提交。", {
    providerId: "openai",
    modelId: "gpt-5",
  });
  assert.deepEqual(
    CommandFileParser.parseCommandFile(rewritten, "/users/me/.zcode/commands/commit.md")
      ?.modelSelectionOverride,
    { providerId: "openai", modelId: "gpt-5" },
  );
});

test("rewrite：删除绑定时清掉两个键，剩余键与 prompt 保持原位", () => {
  const existing = `---
description: 提交
model: openai/gpt-5
model-effort: high
---

请提交。`;
  const rewritten = CommandFileParser.rewriteModelFrontmatter(existing, undefined);
  assert.equal(
    CommandFileParser.parseCommandFile(rewritten, "/users/me/.zcode/commands/commit.md")
      ?.modelSelectionOverride,
    undefined,
  );
  assert.match(rewritten, /description: 提交/);
  assert.match(rewritten, /请提交。/);
  assert.doesNotMatch(rewritten, /model:/);
  assert.doesNotMatch(rewritten, /model-effort:/);
});

test("rewrite：仅剩绑定键时删除后不残留空 frontmatter 块", () => {
  const existing = `---
model: openai/gpt-5
---

请提交。`;
  const rewritten = CommandFileParser.rewriteModelFrontmatter(existing, undefined);
  assert.equal(rewritten.trim(), "请提交。");
});

test("parse：mode 投影为 modeOverride，坏值按无绑定处理", () => {
  const parsed = CommandFileParser.parseCommandFile(
    `---
description: 整理代码
mode: yolo
---

请整理。`,
    "/users/me/.zcode/commands/tidy.md",
  );
  assert.equal(parsed?.modeOverride, "yolo");
  const bad = CommandFileParser.parseCommandFile(
    `---
description: 整理代码
mode: agent
---

请整理。`,
    "/users/me/.zcode/commands/tidy.md",
  );
  assert.equal(bad?.modeOverride, undefined);
  assert.equal(bad?.description, "整理代码");
});

test("rewrite：缺省 mode 意图时不碰已存的 mode 键", () => {
  // 落盘语义：表单未动模式区（modeTouched 为 false）不能把已存的 mode 洗掉。
  const existing = `---
description: 提交
model: openai/gpt-5
mode: yolo
---

请提交。`;
  const kept = CommandFileParser.rewriteModelFrontmatter(
    existing,
    { providerId: "zcode", modelId: "glm-5.3" },
    undefined,
    false,
  );
  assert.match(kept, /mode: yolo/);
  assert.doesNotMatch(kept, /openai\/gpt-5/);
});

test("rewrite：显式声明 mode 意图时可写可删", () => {
  const existing = `---
description: 提交
model: openai/gpt-5
mode: yolo
---

请提交。`;
  const switched = CommandFileParser.rewriteModelFrontmatter(existing, undefined, "plan", true);
  const reparsed = CommandFileParser.parseCommandFile(
    switched,
    "/users/me/.zcode/commands/commit.md",
  );
  assert.equal(reparsed?.modeOverride, "plan");
  assert.equal(reparsed?.modelSelectionOverride, undefined);
  const cleared = CommandFileParser.rewriteModelFrontmatter(existing, undefined, undefined, true);
  assert.doesNotMatch(cleared, /mode:/);
  assert.match(cleared, /description: 提交/);
});

test("generate：编辑表单保存重写文件时保留旧文件头的 model 绑定", () => {
  // 命令编辑表单的保存两步写依赖该语义：第一步 updateCommandFile 重写
  // description / prompt 时不能丢 model 键；第二步只在表单模型与落盘结果
  // 不一致时才覆盖写。旧 binding 必须在第一步原样保留。
  const existing = `---
description: 旧描述
model: openai/gpt-5
model-effort: high
---

旧提示词。`;
  const rewritten = CommandFileParser.generateCommandFileContent(
    { name: "commit", prompt: "新提示词。", description: "新描述" },
    "markdown",
    existing,
  );
  assert.deepEqual(
    CommandFileParser.parseCommandFile(rewritten, "/users/me/.zcode/commands/commit.md")
      ?.modelSelectionOverride,
    { providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "high" } },
  );
  assert.match(rewritten, /新提示词。/);
  assert.match(rewritten, /description: 新描述/);
});
