import assert from "node:assert/strict";
import test from "node:test";
import { buildDraftCreateConfigPayload } from "../src/v4/composer/useDraftConfigControl.js";

// 会话语言在创建这一刻快照进 createSession payload，之后改全局界面语言不影响这个会话。
// 但同一个构造函数也被「首发前 config 收敛比对」复用，那条路径不能带上语言，
// 否则无关的 CAS 会把会话语言卷进去。

test("buildDraftCreateConfigPayload：传入语言时写入 config.language", () => {
  const payload = buildDraftCreateConfigPayload({ mode: "yolo" }, undefined, "zh-CN");

  assert.equal(payload.config?.language, "zh-CN");
  assert.equal(payload.config?.mode, "yolo");
});

test("buildDraftCreateConfigPayload：语言与 followupMode 共存，互不覆盖", () => {
  const payload = buildDraftCreateConfigPayload({ mode: "yolo" }, "guide", "en-US");

  assert.equal(payload.config?.followupMode, "guide");
  assert.equal(payload.config?.language, "en-US");
});

test("buildDraftCreateConfigPayload：不传语言时 config 里没有 language 键", () => {
  const payload = buildDraftCreateConfigPayload({ mode: "yolo" });

  assert.equal(Object.hasOwn(payload.config ?? {}, "language"), false);
});

test("buildDraftCreateConfigPayload：空语言不写入（未知不能凭空补值）", () => {
  const payload = buildDraftCreateConfigPayload(
    { mode: "yolo" },
    undefined,
    // 全局 locale 理论上不会是空串；真出现了也不能让 config.language="" 通过协议校验。
    "" as never,
  );

  assert.equal(Object.hasOwn(payload.config ?? {}, "language"), false);
});

test("buildDraftCreateConfigPayload：无任何 config 时不携带 config 键", () => {
  assert.deepEqual(buildDraftCreateConfigPayload({}), {});
});
