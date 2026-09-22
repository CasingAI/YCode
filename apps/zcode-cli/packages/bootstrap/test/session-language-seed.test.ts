import assert from "node:assert/strict";
import test from "node:test";
import { sessionConfigStateSchema } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 会话语言没有会话事件，config 里的值只能由种子注入：发布者创建时和冷恢复 hydration
// 都会调用 seedConfig。这里锁住「种子写入 + 幂等 + 不伪造 revision」三点。

test("seedConfig：注入会话语言到 snapshot.config", () => {
  const projection = new ProductProjection("sess-language", "epoch-1");

  projection.seedConfig({ language: "zh-CN" });

  assert.equal(projection.getSnapshot().config.language, "zh-CN");
});

test("seedConfig：种子不递增 revision，draft 的「无可见 delta」裁决不被破坏", () => {
  const projection = new ProductProjection("sess-language", "epoch-1");
  const before = projection.getSnapshot().revision;

  projection.seedConfig({ language: "zh-CN" });

  assert.equal(projection.getSnapshot().revision, before);
});

test("seedConfig：重复种同一个语言是幂等的", () => {
  const projection = new ProductProjection("sess-language", "epoch-1");

  projection.seedConfig({ language: "zh-CN" });
  const snapshot = projection.getSnapshot();
  projection.seedConfig({ language: "zh-CN" });

  // 值未变化时不应替换 snapshot 对象（否则下游按引用比对会误判为有更新）。
  assert.equal(projection.getSnapshot(), snapshot);
});

test("seedConfig：种子不带语言时保留已有值，不清空", () => {
  const projection = new ProductProjection("sess-language", "epoch-1");

  projection.seedConfig({ language: "zh-CN" });
  projection.seedConfig({ mode: "plan" });

  assert.equal(projection.getSnapshot().config.language, "zh-CN");
});

test("seedConfig：语言进入 provider schema 校验通过（可选、无默认值）", () => {
  const projection = new ProductProjection("sess-language", "epoch-1");
  projection.seedConfig({ language: "en-US" });

  const parsed = sessionConfigStateSchema.safeParse(projection.getSnapshot().config);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.language, "en-US");

  // 没有语言事实时必须是「字段缺席」，而不是被默认值强行断言成某种语言。
  const withoutLanguage = new ProductProjection("sess-language-2", "epoch-1");
  const parsedWithout = sessionConfigStateSchema.safeParse(withoutLanguage.getSnapshot().config);
  assert.equal(parsedWithout.success, true);
  assert.equal(parsedWithout.data?.language, undefined);
});
