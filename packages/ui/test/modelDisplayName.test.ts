import assert from "node:assert/strict";
import test from "node:test";
import { formatModelDisplayName } from "../src/lib/modelDisplayName.js";

// 输入区胶囊的模型展示名（docs/specs/composer-model-display-name.md）：
// 只做排版派生，模型 id 本身仍是配置、目录与请求的事实。断言的样例取自内置模型目录，
// 规则改动时这份表就是最先被打破的地方。

test("kebab / 下划线 / 空格分词的 id 转成首字母大写", () => {
  assert.equal(formatModelDisplayName("deepseek-v4.1-flash"), "Deepseek V4.1 Flash");
  assert.equal(formatModelDisplayName("deepseek_v4_flash"), "Deepseek V4 Flash");
  assert.equal(formatModelDisplayName("deepseek v4 flash"), "Deepseek V4 Flash");
  assert.equal(formatModelDisplayName("  deepseek-v4.1-flash\n"), "Deepseek V4.1 Flash");
});

test("缩写整词大写，而不是首字母大写", () => {
  assert.equal(formatModelDisplayName("glm-5.3-flash"), "GLM 5.3 Flash");
  assert.equal(formatModelDisplayName("gpt-5.4-mini"), "GPT 5.4 Mini");
  assert.equal(formatModelDisplayName("qwen3-vl-plus"), "Qwen3 VL Plus");
  assert.equal(formatModelDisplayName("xiaomi/mimo-v2.5-pro"), "xiaomi/Mimo V2.5 Pro");
});

test("已含大写或非 ASCII 的词保留原写法", () => {
  assert.equal(formatModelDisplayName("GLM-4.1V-Thinking-FlashX"), "GLM 4.1V Thinking FlashX");
  assert.equal(formatModelDisplayName("GLM-4-FlashX-250414"), "GLM 4 FlashX 250414");
  assert.equal(formatModelDisplayName("MiniMax-M2.1-highspeed"), "MiniMax M2.1 Highspeed");
  // 大写在任意字符集里都算「厂商写法」，非拉丁脚本整词原样，不被拉丁排版规则压平。
  assert.equal(formatModelDisplayName("МОДЕЛЬ-2"), "МОДЕЛЬ 2");
  assert.equal(formatModelDisplayName("МоДель-2"), "МоДель 2");
  assert.equal(formatModelDisplayName("我的模型-v2"), "我的模型 V2");
  assert.equal(formatModelDisplayName("我的Model"), "我的Model");
  // 拉丁字母（含变音）与符号不走「整词保留」，只按首字母大写处理。
  assert.equal(formatModelDisplayName("café-model"), "Café Model");
  assert.equal(formatModelDisplayName("custom_model@2024"), "Custom Model@2024");
});

test("版本号后的视觉标记大写，其它数字字母混排保持原样", () => {
  assert.equal(formatModelDisplayName("z-ai/glm-4.6v"), "z-ai/GLM 4.6V");
  assert.equal(formatModelDisplayName("z-ai/glm-5v-turbo"), "z-ai/GLM 5V Turbo");
  assert.equal(formatModelDisplayName("GLM-4.6V"), "GLM 4.6V");
  assert.equal(formatModelDisplayName("k3-256k"), "K3 256k");
});

test("相邻的单个数字并成版本号，多位数字不参与合并", () => {
  assert.equal(formatModelDisplayName("claude-sonnet-4-5"), "Claude Sonnet 4.5");
  assert.equal(formatModelDisplayName("claude-opus-5"), "Claude Opus 5");
  // 相邻的两位数字不合并（旧规则会把这里并成 24.7）。
  assert.equal(formatModelDisplayName("model-24-7"), "Model 24 7");
  // 日期戳与型号后缀不并进版本号。
  assert.equal(formatModelDisplayName("claude-haiku-4-5-20251001"), "Claude Haiku 4.5 20251001");
  assert.equal(formatModelDisplayName("glm-4-flash-250414"), "GLM 4 Flash 250414");
});

test("vendor slug 原样保留，只格式化模型段", () => {
  assert.equal(formatModelDisplayName("anthropic/claude-opus-4.5"), "anthropic/Claude Opus 4.5");
  assert.equal(formatModelDisplayName("z-ai/glm-5.3-flash"), "z-ai/GLM 5.3 Flash");
  assert.equal(formatModelDisplayName("x-ai/grok-build-0.1"), "x-ai/Grok Build 0.1");
});

test("单段、带数字字母混合与纯数字的 id", () => {
  assert.equal(formatModelDisplayName("emohaa"), "Emohaa");
  assert.equal(formatModelDisplayName("hy3"), "Hy3");
  assert.equal(formatModelDisplayName("k3-256k"), "K3 256k");
  assert.equal(
    formatModelDisplayName("deepseek-v4-flash-vision-exp"),
    "Deepseek V4 Flash Vision Exp",
  );
});

test("空值与空白返回空串，由调用方兜底", () => {
  assert.equal(formatModelDisplayName(""), "");
  assert.equal(formatModelDisplayName("   "), "");
});
