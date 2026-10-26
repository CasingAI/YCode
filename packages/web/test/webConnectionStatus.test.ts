import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/WebConnectionStatus.tsx", import.meta.url), "utf8");
const indicatorClasses = source.match(/<span\s+aria-hidden="true"\s+className=\{`([^`]+)`\}/)?.[1];

test("首次连接与重新连接使用 20px 旋转环，不复用静态圆点尺寸", () => {
  assert.ok(indicatorClasses, "连接状态指示器必须保持 aria-hidden");
  const commonClasses = indicatorClasses.split("${")[0];
  const spinnerClasses = indicatorClasses.match(
    /resolved\.tier === "connecting" \|\| resolved\.tier === "recovering"\s*\? "([^"]+)"/,
  )?.[1];

  assert.ok(spinnerClasses, "首次连接和重新连接必须使用同一旋转环分支");
  assert.match(spinnerClasses, /\bsize-5\b/, "旋转环必须为 20px，明显大于默认状态文字");
  assert.match(spinnerClasses, /\banimate-spin\b/);
  assert.doesNotMatch(commonClasses, /\bsize-/, "公共样式不能固定为静态圆点尺寸");
  assert.match(commonClasses, /\bshrink-0\b/, "窄屏下也不能压缩旋转环");
  assert.match(spinnerClasses, /\bmotion-reduce:animate-none\b/);
});

test("等待重试与已恢复仍使用 8px 静态圆点", () => {
  assert.ok(indicatorClasses);
  const dotClasses = [...indicatorClasses.matchAll(/"([^"]*\bbg-(?:success|warning)\b[^"]*)"/g)]
    .map((match) => match[1])
    .filter((classes) => !classes.includes("animate-spin"));

  assert.equal(dotClasses.length, 2, "等待重试和已恢复必须保留各自的静态圆点");
  for (const classes of dotClasses) {
    assert.match(classes, /\bsize-2\b/, "静态圆点必须保持 8px");
    assert.doesNotMatch(classes, /\banimate-spin\b/);
  }
});
