import assert from "node:assert/strict";
import test from "node:test";
import {
  ESTIMATED_TOKEN_WEIGHT_CJK,
  ESTIMATED_TOKEN_WEIGHT_OTHER,
  estimateTokens,
} from "../src/context/utils.js";

test("Token 估算：权重常量为中 0.6 / 其余 0.3", () => {
  assert.equal(ESTIMATED_TOKEN_WEIGHT_CJK, 0.6);
  assert.equal(ESTIMATED_TOKEN_WEIGHT_OTHER, 0.3);
});

test("Token 估算：纯英文按每字符 0.3 计入", () => {
  const text = "The quick brown fox jumps over the lazy dog";
  assert.equal(estimateTokens(text), Math.ceil(text.length * ESTIMATED_TOKEN_WEIGHT_OTHER));
});

test("Token 估算：纯中文按每字符 0.6 计入，约为同长度英文的两倍", () => {
  // 逐字符向上取整，短文本下会把比值从 2 拉偏（14 字符时理论 8.4 / 4.2 取整成 9 / 5，
  // 比值只剩 1.8），因此用长样本验证权重比例本身。
  const chinese = "上下文容量明细按加权口径估算，中文内容越多占比越接近真实用量。".repeat(20);
  const english = "a".repeat(chinese.length);
  assert.equal(estimateTokens(chinese), Math.ceil(chinese.length * ESTIMATED_TOKEN_WEIGHT_CJK));
  const ratio = estimateTokens(chinese) / estimateTokens(english);
  assert.ok(ratio > 1.95 && ratio <= 2, `中文/英文估算比值应接近 2，实际 ${ratio}`);
});

test("Token 估算：CJK 标点与全角形式按中文权重计入", () => {
  // 「、。，（）」这类符号在中文文本里密度很高，只匹配汉字会系统性低估中文占比。
  const punctuation = "、。，（）：";
  assert.equal(estimateTokens(punctuation), Math.ceil(punctuation.length * ESTIMATED_TOKEN_WEIGHT_CJK));
  assert.equal(estimateTokens(punctuation), estimateTokens("一一一一一一"));
});

test("Token 估算：混合文本按两种权重分别累加", () => {
  const english = "Refactor";
  const chinese = "上下文估算";
  assert.equal(
    estimateTokens(english + chinese),
    Math.ceil(
      english.length * ESTIMATED_TOKEN_WEIGHT_OTHER + chinese.length * ESTIMATED_TOKEN_WEIGHT_CJK,
    ),
  );
});

test("Token 估算：结果向上取整，不返回小数 token", () => {
  for (const text of ["a", "中", "a中", "hello world", "你好世界"]) {
    assert.ok(Number.isInteger(estimateTokens(text)), `${text} 应返回整数 token`);
  }
});

test("Token 估算：空文本返回 0", () => {
  assert.equal(estimateTokens(""), 0);
});

test("Token 估算：同语言内文本变长，估算值单调不减", () => {
  // 只在同语言内比较：中文每字符 0.6 高于英文的 0.3，跨语言长度与 token 不成比例。
  for (const prefix of ["", "a", "hello", "hello world"]) {
    const current = estimateTokens(prefix);
    const longer = estimateTokens(`${prefix}${prefix}`);
    assert.ok(longer >= current, `英文文本 ${prefix} 变长后估算值不应变小`);
  }
  for (const prefix of ["", "你", "你好", "你好世界"]) {
    const current = estimateTokens(prefix);
    const longer = estimateTokens(`${prefix}${prefix}`);
    assert.ok(longer >= current, `中文文本 ${prefix} 变长后估算值不应变小`);
  }
});

test("Token 估算：同为两字符时中文估算值约为英文的两倍", () => {
  // ceil 让 1.2 与 0.6 都向上取整为 1，因此中文两字符是 1.2→2，英文两字符是 0.6→1。
  assert.equal(estimateTokens("你好"), 2);
  assert.equal(estimateTokens("ab"), 1);
});
