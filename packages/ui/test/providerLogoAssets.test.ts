import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuiltinProviderLogoAsset } from "../src/settings/model-provider-section/providerLogoAssets.js";

// OpenCode Zen / Go 用各自的官方 console 图标（docs/specs/provider-logo.md）。
// 资源 import 在 node 单测里被 stub 成 "asset-stub"，这里只断言解析分支，不断言具体文件名。
test("opencode-zen 按明暗主题解析为不同素材", () => {
  const light = resolveBuiltinProviderLogoAsset({ type: "builtin", key: "opencode-zen" }, "light");
  const dark = resolveBuiltinProviderLogoAsset({ type: "builtin", key: "opencode-zen" }, "dark");
  assert.ok(light, "light 下应解析出素材");
  assert.ok(dark, "dark 下应解析出素材");
  assert.notEqual(light, dark);
});

test("opencode-go 明暗主题共用同一素材", () => {
  const light = resolveBuiltinProviderLogoAsset({ type: "builtin", key: "opencode-go" }, "light");
  const dark = resolveBuiltinProviderLogoAsset({ type: "builtin", key: "opencode-go" }, "dark");
  assert.ok(light, "light 下应解析出素材");
  assert.equal(light, dark);
});

test("旧 opencode key 兼容映射到 Zen 素材", () => {
  const legacyLight = resolveBuiltinProviderLogoAsset(
    { type: "builtin", key: "opencode" },
    "light",
  );
  const legacyDark = resolveBuiltinProviderLogoAsset({ type: "builtin", key: "opencode" }, "dark");
  const zenLight = resolveBuiltinProviderLogoAsset(
    { type: "builtin", key: "opencode-zen" },
    "light",
  );
  const zenDark = resolveBuiltinProviderLogoAsset({ type: "builtin", key: "opencode-zen" }, "dark");
  assert.equal(legacyLight, zenLight);
  assert.equal(legacyDark, zenDark);
});

test("未知 key 降级为 null（调用方渲染通用图标）", () => {
  assert.equal(
    resolveBuiltinProviderLogoAsset({ type: "builtin", key: "opencode-no-such" }, "dark"),
    null,
  );
  assert.equal(resolveBuiltinProviderLogoAsset(null, "dark"), null);
  assert.equal(resolveBuiltinProviderLogoAsset(undefined, "light"), null);
});
