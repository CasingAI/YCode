import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const echoSource = readFileSync(
  new URL("../src/v4/ConversationUserInputContent.tsx", import.meta.url),
  "utf8",
);

// 发送后的 Goal 芯片必须复用编辑器 mention DOM，不能再插一枚 Lucide SVG。
test("权威 Goal 芯片复用 prompt-mention 与 slash mention id", () => {
  assert.match(echoSource, /function GoalEchoMentionChip/);
  assert.match(echoSource, /"prompt-mention"/);
  assert.match(echoSource, /data-mention-id=\{goalEchoMentionId\(label\)\}/);
  assert.match(echoSource, /data-v4-user-input-command="goal"/);
  assert.match(echoSource, /decoratePromptMention\(node, "commands", command\)/);
  assert.equal(echoSource.includes("GoalIcon"), false);
});
