import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rowViewSource = readFileSync(
  new URL("../src/v4/ConversationRowView.tsx", import.meta.url),
  "utf8",
);

test("消息编辑态图片移除叉号使用主题前景色", () => {
  assert.match(rowViewSource, /className="absolute top-0\.5 right-0\.5[^\"]*text-foreground/);
  assert.doesNotMatch(
    rowViewSource,
    /className="absolute top-0\.5 right-0\.5[^\"]*text-primary-foreground/,
  );
});
