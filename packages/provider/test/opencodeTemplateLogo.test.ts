import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseZCodeBuiltinProviderConfigRules } from "../src/index.js";

const BUILTIN_URL = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);

// OpenCode Zen / Go 用各自的官方 console 图标（docs/specs/provider-logo.md）：
// go 模板走 opencode-go key，zen 模板走 opencode-zen key，不再共用旧 opencode key。
async function loadTemplateLogoKeys(): Promise<ReadonlyMap<string, string | undefined>> {
  const release = JSON.parse(await readFile(BUILTIN_URL, "utf8")) as {
    config: { providerConfigRules: unknown };
  };
  const builtin = parseZCodeBuiltinProviderConfigRules(release.config.providerConfigRules);
  const result = new Map<string, string | undefined>();
  for (const templateId of builtin.providerTemplates.keys()) {
    result.set(templateId, builtin.providerTemplates.get(templateId)?.config.logo?.key);
  }
  return result;
}

test("OpenCode Go 内置模板使用 opencode-go logo key", async () => {
  const logos = await loadTemplateLogoKeys();
  for (const templateId of ["opencode-go-chat", "opencode-go-messages", "opencode-go-responses"]) {
    assert.ok(logos.has(templateId), `内置模板缺失: ${templateId}`);
    assert.equal(logos.get(templateId), "opencode-go");
  }
});

test("OpenCode Zen 内置模板使用 opencode-zen logo key", async () => {
  const logos = await loadTemplateLogoKeys();
  for (const templateId of [
    "opencode-zen-responses",
    "opencode-zen-messages",
    "opencode-zen-chat",
  ]) {
    assert.ok(logos.has(templateId), `内置模板缺失: ${templateId}`);
    assert.equal(logos.get(templateId), "opencode-zen");
  }
});

test("不再有内置模板使用旧 opencode 共用 logo key", async () => {
  const logos = await loadTemplateLogoKeys();
  for (const [templateId, logoKey] of logos) {
    assert.notEqual(logoKey, "opencode", `模板仍用旧共用 key: ${templateId}`);
  }
});
