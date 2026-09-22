import assert from "node:assert/strict";
import test from "node:test";
import { buildPrewarmInitialDraftConfig } from "../src/v4/composer/useDraftConfigControl.js";

// 预热 createSession 是「新建对话」流程里新会话真正的创建点：预热成功后首发 sendText
// 直接提升、不会再补发 createSession。会话语言是创建时快照
// （docs/specs/session-language.md），必须在这里随 payload 带上——此前该路径漏带
// language，会话语言永远未知，Bash description 提示退回默认英文文案。

test("buildPrewarmInitialDraftConfig：无 mode 时仅携带语言快照", () => {
  const config = buildPrewarmInitialDraftConfig({}, undefined, "zh-CN");

  assert.deepEqual(config, { language: "zh-CN" });
});

test("buildPrewarmInitialDraftConfig：无 mode 且无语言时保持旧行为返回 undefined", () => {
  const config = buildPrewarmInitialDraftConfig({}, undefined);

  assert.equal(config, undefined);
});

test("buildPrewarmInitialDraftConfig：有 mode 时草稿字段、followupMode 与语言共存", () => {
  const config = buildPrewarmInitialDraftConfig({ mode: "yolo" }, "guide", "zh-CN");

  assert.deepEqual(config, { mode: "yolo", followupMode: "guide", language: "zh-CN" });
});

test("buildPrewarmInitialDraftConfig：有 mode 且无语言时不出现 language 键", () => {
  const config = buildPrewarmInitialDraftConfig({ mode: "yolo" }, undefined);

  assert.deepEqual(config, { mode: "yolo" });
  assert.equal(Object.hasOwn(config ?? {}, "language"), false);
});

test("buildPrewarmInitialDraftConfig：草稿里的其他字段原样保留", () => {
  const config = buildPrewarmInitialDraftConfig(
    { mode: "yolo", planEnabled: true },
    undefined,
    "en-US",
  );

  assert.deepEqual(config, { mode: "yolo", planEnabled: true, language: "en-US" });
});
