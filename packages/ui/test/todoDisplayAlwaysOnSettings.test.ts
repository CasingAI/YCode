import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

test("设置页不再提供显示待办开关与文案", async () => {
  const [settingsPageSource, settingsHelpersSource, userActionTraceSource] = await Promise.all(
    [
      "../src/SettingsPage.tsx",
      "../src/settingsPageHelpers.tsx",
      "../src/lib/userActionTraceCatalog.ts",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  assert.equal(zhCN["settings.messageStreamShowTodos"], undefined);
  assert.equal(enUS["settings.messageStreamShowTodos"], undefined);
  assert.equal(zhCN["settings.messageStreamShowTodosDescription"], undefined);
  assert.equal(enUS["settings.messageStreamShowTodosDescription"], undefined);
  assert.equal(settingsPageSource.includes("messageStreamShowTodos"), false);
  assert.equal(settingsHelpersSource.includes("messageStreamShowTodos"), false);
  assert.equal(userActionTraceSource.includes("toggle_show_todos"), false);
});
