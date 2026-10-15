import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rowViewSource = readFileSync(
  new URL("../src/v4/ConversationRowView.tsx", import.meta.url),
  "utf8",
);
const shareTimelineSource = readFileSync(
  new URL("../src/v4/ConversationShareReadonlyTimeline.tsx", import.meta.url),
  "utf8",
);
const zhCN = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUS = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

test("撤回 marker 使用独立弱提示行，而不是 marker 分隔线", () => {
  assert.match(rowViewSource, /case "replyWithdrawn"[\s\S]*?chat\.replyWithdrawn/);
  assert.match(rowViewSource, /if \(marker\.type === "replyWithdrawn"\)[\s\S]*?text-ui-xs/);
  assert.doesNotMatch(
    rowViewSource.match(/if \(marker\.type === "replyWithdrawn"\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? "",
    /MarkerDividerRow/,
  );
});

test("撤回提示提供指定的中文与英文文案", () => {
  assert.match(zhCN, /"chat\.replyWithdrawn":\s*"模型撤回了一条未完成的回复"/);
  assert.match(enUS, /"chat\.replyWithdrawn":\s*"The model withdrew an unfinished reply"/);
  assert.match(shareTimelineSource, /markerReplyWithdrawn: "模型撤回了一条未完成的回复"/);
  assert.match(shareTimelineSource, /markerReplyWithdrawn: "The model withdrew an unfinished reply"/);
});
