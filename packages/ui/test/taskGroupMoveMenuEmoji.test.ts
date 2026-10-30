import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskActionMenuContent } from "../src/TaskActionMenuContent.js";

/**
 * 移动任务到分组的菜单项：有 emoji 时用 EmojiGlyph 16px 取代颜色点，
 * 不额外加颜色圆；无 emoji 保留原 TaskGroupColorDot。
 */

function Item({ children, title }: { children?: ReactNode; title?: string }) {
  return createElement("div", { title }, children);
}

function Separator() {
  return createElement("hr");
}

function Sub({ children }: { children?: ReactNode }) {
  return createElement("div", null, children);
}

function SubTrigger({ children, title }: { children?: ReactNode; title?: string }) {
  return createElement("div", { title }, children);
}

function SubContent({ children }: { children?: ReactNode }) {
  return createElement("div", null, children);
}

function noop() {}

test("扁平菜单：有 emoji 的组项显示 EmojiGlyph，无 emoji 保留颜色点", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskActionMenuContent, {
      intl: { formatMessage: ({ id }: { id: string }) => id },
      isPinned: false,
      fileManagerLabel: "Files",
      taskSessionFile: { loading: false, path: null, exists: false },
      taskNativeSessionLogFile: { loading: false, path: null, exists: false },
      Item,
      Separator,
      Sub,
      SubTrigger,
      SubContent,
      onTogglePinTask: noop,
      onStartRenameTask: noop,
      onArchiveTask: noop,
      onMarkTaskAsUnread: noop,
      onOpenTaskPathInFileManager: noop,
      onCopyWorkspacePath: noop,
      onCopyTaskPath: noop,
      onCopyTaskLogPath: noop,
      groupMenu: {
        groups: [
          { id: "g-rocket", title: "火箭组", color: "blue", emoji: "🚀" },
          { id: "g-plain", title: "普通组", color: "red" },
        ],
        currentGroupId: "g-rocket",
        onMoveToGroup: noop,
        onCreateGroupAndMove: noop,
      },
    }),
  );

  assert.match(markup, /emoji_u1f680\.png/);
  assert.match(markup, /style="width:16px;height:16px"/);
  assert.doesNotMatch(markup, />🚀</);
  assert.doesNotMatch(markup, /bg-sky-300/, "有 emoji 的组项不再叠加颜色点");
  assert.match(markup, /bg-rose-300/, "无 emoji 的组项继续使用原颜色点");
  assert.match(markup, /火箭组/);
  assert.match(markup, /普通组/);
});

test("右键移动菜单同样按 emoji 条件切换 EmojiGlyph/颜色点", () => {
  const source = readFileSync(
    new URL("../src/workspace-grouped-tasks/task-context-menu-content.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /group\.emoji \? \(\s*<EmojiGlyph emoji=\{group\.emoji\} size=\{16\}/,
    "有 emoji 时必须渲染 EmojiGlyph",
  );
  assert.match(source, /<TaskGroupColorDot color=\{group\.color\} \/>/, "无 emoji 保留原颜色点");
  assert.match(source, /className="truncate">\{group\.title\}/);
});
