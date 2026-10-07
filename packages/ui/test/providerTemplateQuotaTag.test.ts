import assert from "node:assert/strict";
import test from "node:test";
import {
  supportsTemplateBetaTag,
  supportsTemplateQuotaDisplay,
} from "@/settings/model-provider-section/providerTemplateQuotaTag.js";

test("DeepSeek 模板标注已适配额度显示", () => {
  assert.equal(supportsTemplateQuotaDisplay("deepseek"), true);
});

test("全部 OpenCode 模板按前缀自动标注", () => {
  for (const templateId of [
    "opencode-go-chat",
    "opencode-go-messages",
    "opencode-go-responses",
    "opencode-zen-chat",
    "opencode-zen-messages",
    "opencode-zen-responses",
  ]) {
    assert.equal(supportsTemplateQuotaDisplay(templateId), true, templateId);
  }
});

test("未新增适配能力的 opencode 模板自动继承标注", () => {
  assert.equal(supportsTemplateQuotaDisplay("opencode-future-thing"), true);
});

test("MiniMax Token Plan 与 OpenRouter 标注已适配额度显示", () => {
  assert.equal(supportsTemplateQuotaDisplay("minimax-token-plan"), true);
  assert.equal(supportsTemplateQuotaDisplay("openrouter"), true);
});

test("MiniMax Token Plan 与 OpenRouter 带 Beta：未经真实账号验证", () => {
  assert.equal(supportsTemplateBetaTag("minimax-token-plan"), true);
  assert.equal(supportsTemplateBetaTag("openrouter"), true);
});

test("Go / DeepSeek / Zen 不带 Beta", () => {
  for (const templateId of [
    "deepseek",
    "opencode-go-chat",
    "opencode-zen-chat",
    "opencode-future-thing",
  ]) {
    assert.equal(supportsTemplateBetaTag(templateId), false, templateId);
  }
});

test("MiniMax 平台模板无额度能力：不标 quota 也不标 Beta", () => {
  assert.equal(supportsTemplateQuotaDisplay("minimax"), false);
  assert.equal(supportsTemplateBetaTag("minimax"), false);
});

test("智谱 Coding Plan 模板不标注：额度只挂在账号级 provider 上", () => {
  for (const templateId of [
    "zai-api",
    "bigmodel-api",
    "zai-standard-api",
    "bigmodel-standard-api",
  ]) {
    assert.equal(supportsTemplateQuotaDisplay(templateId), false, templateId);
  }
});

test("其余内置模板与自定义 provider 都不标注", () => {
  for (const templateId of [
    "moonshot-kimi",
    "minimax",
    "deepseek-proxy",
    "qwen-alibaba-model-studio-cn",
    "qwen-alibaba-model-studio-intl",
    "xiaomi-mimo",
    "openai",
    "anthropic",
    "xai",
    "custom",
    "",
  ]) {
    assert.equal(supportsTemplateQuotaDisplay(templateId), false, templateId);
  }
});
