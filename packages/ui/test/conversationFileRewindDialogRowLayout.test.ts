import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialogSource = readFileSync(
  new URL("../src/v4/ConversationFileRewindDialog.tsx", import.meta.url),
  "utf8",
);

/**
 * 规则 31（specs/message-history-edit.md）：回滚弹窗的文件清单行是「路径 + 原因」两段。
 *
 * 路径是绝对路径，很容易长于弹窗宽度。清单行是 grid item，min-width 默认 auto 会按
 * 路径的 max-content 撑开整行，把右侧原因文案挤出弹窗边界（真机上表现为右侧文字被裁掉、
 * 弹窗出现横向滚动）。因此行自身必须显式 min-w-0，让路径由 truncate 收缩、原因保持完整。
 *
 * 仓库没有 DOM/布局测试基建，这里按既有布局测试的范式断言源码上的类名契约。
 */
function readPreviewFileListSource(): string {
  const startIndex = dialogSource.indexOf("function PreviewFileList(");
  assert.notEqual(startIndex, -1, "缺少 PreviewFileList 组件");
  const endIndex = dialogSource.indexOf(
    "export function ConversationFileRewindDialog(",
    startIndex,
  );
  assert.notEqual(endIndex, -1, "缺少 PreviewFileList 组件结束位置");
  return dialogSource.slice(startIndex, endIndex);
}

test("文件清单行显式 min-w-0，长路径不撑破弹窗", () => {
  const listSource = readPreviewFileListSource();

  const rowTag = listSource.match(/<div\s+key=\{`\$\{type\}:\$\{file\.path\}`\}[\s\S]*?>/);
  assert.ok(rowTag, "必须存在文件清单行容器");
  assert.match(
    rowTag[0],
    /className="[^"]*\bmin-w-0\b[^"]*"/,
    "清单行必须显式 min-w-0，否则 grid item 会被长路径的 max-content 撑开",
  );
  assert.match(
    rowTag[0],
    /className="[^"]*\bflex\b[^"]*"/,
    "清单行必须是 flex 容器，路径与原因并排",
  );
});

test("路径可收缩截断，原因文案不收缩", () => {
  const listSource = readPreviewFileListSource();

  const pathTag = listSource.match(/<span\s+className="[^"]*truncate[^"]*"[\s\S]*?>/);
  assert.ok(pathTag, "必须存在路径元素");
  assert.match(pathTag[0], /\bmin-w-0\b/, "路径必须 min-w-0 才能在 flex 行内收缩");
  assert.match(pathTag[0], /\btruncate\b/, "路径必须 truncate，超长时显示省略号");

  const reasonTag = listSource.match(/<span\s+className="[^"]*shrink-0[^"]*"[\s\S]*?>/);
  assert.ok(reasonTag, "必须存在原因文案元素");
  assert.match(reasonTag[0], /\bshrink-0\b/, "原因文案必须 shrink-0，保证完整可见");
});

test("路径被截断时可通过 title 查看完整路径", () => {
  const listSource = readPreviewFileListSource();
  assert.match(listSource, /title=\{file\.path\}/, "路径必须带 title，截断后仍可查看完整绝对路径");
});
