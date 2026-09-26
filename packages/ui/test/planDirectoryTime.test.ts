import assert from "node:assert/strict";
import test from "node:test";
import { formatPlanCreatedAt } from "../src/app-shell/planDirectoryTime.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/** 与 IntlProvider.createIntl 同样的替换语义，测试直接用真实文案表而不是复制一份。 */
function makeFormatMessage(messages: Record<string, string>) {
  return ({ id }: { id: string }, values?: Record<string, string>) => {
    let message = messages[id] ?? id;
    if (values) {
      for (const [key, value] of Object.entries(values)) {
        message = message.replaceAll(`{${key}}`, String(value));
      }
    }
    return message;
  };
}

const NOW = new Date(2026, 8, 26, 15, 0, 0);

test("同年计划只显示月日和时间，不带年份", () => {
  const label = formatPlanCreatedAt({
    createdAt: new Date(2026, 8, 20, 16, 40, 5).toISOString(),
    formatMessage: makeFormatMessage(zhCN),
    locale: "zh-CN",
    now: NOW,
  });
  assert.equal(label?.label, "9 月 20 日 16:40:05");
  assert.equal(label?.title, "2026 年 9 月 20 日 16:40:05");
});

test("跨年计划在行内补上年份，title 始终带年份", () => {
  const label = formatPlanCreatedAt({
    createdAt: new Date(2025, 11, 31, 9, 5, 0).toISOString(),
    formatMessage: makeFormatMessage(zhCN),
    locale: "zh-CN",
    now: NOW,
  });
  assert.equal(label?.label, "2025 年 12 月 31 日 09:05:00");
  assert.equal(label?.title, "2025 年 12 月 31 日 09:05:00");
});

test("英文 locale 走英文日期格式", () => {
  const label = formatPlanCreatedAt({
    createdAt: new Date(2025, 11, 31, 9, 5, 0).toISOString(),
    formatMessage: makeFormatMessage(enUS),
    locale: "en-US",
    now: NOW,
  });
  assert.equal(label?.label, "2025/12/31 09:05:00");
  assert.equal(label?.title, "2025/12/31 09:05:00");
});

test("同一分钟内的两份计划能靠秒位分出先后", () => {
  const formatMessage = makeFormatMessage(zhCN);
  const base = { formatMessage, locale: "zh-CN" as const, now: NOW };
  const earlier = formatPlanCreatedAt({
    ...base,
    createdAt: new Date(2026, 8, 26, 13, 55, 24).toISOString(),
  });
  const later = formatPlanCreatedAt({
    ...base,
    createdAt: new Date(2026, 8, 26, 13, 55, 42).toISOString(),
  });
  assert.notEqual(earlier?.label, later?.label);
  assert.ok(later?.label.endsWith("13:55:42"));
});

test("createdAt 缺失或解析不出时返回 null，由调用方整行不渲染", () => {
  const formatMessage = makeFormatMessage(zhCN);
  const base = { formatMessage, locale: "zh-CN" as const, now: NOW };
  assert.equal(formatPlanCreatedAt({ ...base, createdAt: undefined }), null);
  assert.equal(formatPlanCreatedAt({ ...base, createdAt: "不是时间" }), null);
});

test("时间文案不残留未替换的占位符", () => {
  const createdAt = new Date(2026, 0, 2, 8, 7, 0).toISOString();
  for (const [locale, messages] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    const label = formatPlanCreatedAt({
      createdAt,
      formatMessage: makeFormatMessage(messages),
      locale,
      now: NOW,
    });
    assert.doesNotMatch(label?.label ?? "", /[{}]/);
    assert.doesNotMatch(label?.title ?? "", /[{}]/);
  }
});
