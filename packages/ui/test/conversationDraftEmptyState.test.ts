import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const emptyStatePath = new URL("../src/v4/ConversationDraftEmptyState.tsx", import.meta.url);
const sessionPaneSource = readFileSync(
  new URL("../src/v4/SessionPane.tsx", import.meta.url),
  "utf8",
);
const zhCnSource = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUsSource = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

// 中文注释说明原因：问候语在桌面端偶发半透明残影且与水印叠加反复出问题，
// 用户决定彻底去掉；测试钉住组件删除、空态槽位为 null 与文案删除，防止恢复。
test("新建页空态不再渲染问候语组件", () => {
  assert.equal(existsSync(emptyStatePath), false, "问候语组件必须已删除");
  assert.ok(
    !sessionPaneSource.includes("ConversationDraftEmptyState"),
    "SessionPane 不得再引用问候语组件",
  );
  assert.ok(
    sessionPaneSource.includes("emptyState={null}"),
    "草稿空态槽位必须为 null，只保留底部 Dock 居中",
  );
});

test("新建页空态不再渲染装饰水印", () => {
  for (const forbiddenFragment of [
    "ConversationDraftEmptyState",
    "chat.empty.watermark",
    "text-[length:min(30vw,13rem)]",
    "-translate-x-1/2 -translate-y-1/2",
  ]) {
    assert.ok(
      !sessionPaneSource.includes(forbiddenFragment),
      `空态不得恢复装饰水印或问候语：${forbiddenFragment}`,
    );
  }
});

test("中英文语言包不再保留问候语与水印文案", () => {
  assert.doesNotMatch(zhCnSource, /chat\.empty\.greeting/);
  assert.doesNotMatch(enUsSource, /chat\.empty\.greeting/);
  assert.doesNotMatch(zhCnSource, /chat\.empty\.watermark/);
  assert.doesNotMatch(enUsSource, /chat\.empty\.watermark/);
});
