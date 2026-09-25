import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const emptyStateSource = readFileSync(
  new URL("../src/v4/ConversationDraftEmptyState.tsx", import.meta.url),
  "utf8",
);
const zhCnSource = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUsSource = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

test("新建页空态保留问候语选择、宽度测量和原有间距", () => {
  for (const sourceFragment of [
    'id: isOfficeMode ? "chat.empty.greeting.office" : getChatEmptyGreetingMessageId(greetingDate)',
    'data-v4-draft-greeting="true"',
    "greetingMeasurementRef",
    "new ResizeObserver(scheduleMeasure)",
    "text-[length:var(--v4-draft-greeting-font-size)]/[1.2]",
    "mb-10 flex w-full max-w-2xl",
    "sm:mb-8",
  ]) {
    assert.ok(emptyStateSource.includes(sourceFragment), `空态必须保留 ${sourceFragment}`);
  }
});

test("新建页空态不再渲染装饰水印", () => {
  for (const forbiddenFragment of [
    "chat.empty.watermark",
    "text-[length:min(30vw,13rem)]",
    "text-foreground-subtlest opacity-70",
    "-translate-x-1/2 -translate-y-1/2",
  ]) {
    assert.ok(
      !emptyStateSource.includes(forbiddenFragment),
      `空态不得恢复装饰水印：${forbiddenFragment}`,
    );
  }
});

test("中英文语言包不再保留水印文案", () => {
  assert.doesNotMatch(zhCnSource, /chat\.empty\.watermark/);
  assert.doesNotMatch(enUsSource, /chat\.empty\.watermark/);
});
