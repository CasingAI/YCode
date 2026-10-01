import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TaskActionMenuContent } from "../src/TaskActionMenuContent.js";

/**
 * 四项复制动作收进「复制信息」二级菜单后的结构回归。
 *
 * Radix 真组件在服务端静态渲染时不输出关闭的子菜单内容，
 * 这里用桩组件替换 Sub 三件套：Sub 只透传 children，
 * SubTrigger 与 SubContent 包一层带 data-slot 的普通标签，
 * 让静态渲染能看到全部内容，进而断言四个复制项的位置。
 */
function StubSub({ children }: { children?: ReactNode }) {
  return createElement("div", null, children);
}

function StubSubTrigger({ children }: { children: ReactNode }) {
  return createElement("div", { "data-slot": "task-menu-sub-trigger" }, children);
}

function StubSubContent({ children }: { children?: ReactNode }) {
  return createElement("div", { "data-slot": "task-menu-sub-content" }, children);
}

function StubItem({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}) {
  return createElement(
    "div",
    { "data-slot": "task-menu-item", "aria-disabled": disabled },
    children,
  );
}

function StubSeparator() {
  return createElement("hr", { "data-slot": "task-menu-separator" });
}

function renderMenu(): string {
  // 桩 intl 原样返回 key：四个复制项断言的是 id 落点，不依赖语言包；
  // 真实文案（zh-CN「复制信息」）由语言包文件承载，typecheck 守住 key 存在。
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TaskActionMenuContent, {
        intl: {
          formatMessage: (desc: { id: string }) => desc.id,
        },
        isPinned: false,
        fileManagerLabel: "fileManager",
        taskSessionFile: { loading: false, path: "/tmp/task.json", exists: true },
        activeSessionId: "sess-1",
        taskNativeSessionLogFile: { loading: false, path: "/tmp/task.log", exists: true },
        Item: StubItem as never,
        Separator: StubSeparator as never,
        Sub: StubSub as never,
        SubTrigger: StubSubTrigger as never,
        SubContent: StubSubContent as never,
        onTogglePinTask: () => undefined,
        onStartRenameTask: () => undefined,
        onArchiveTask: () => undefined,
        onMarkTaskAsUnread: () => undefined,
        onOpenTaskPathInFileManager: () => undefined,
        onCopyWorkspacePath: () => undefined,
        onCopyTaskPath: () => undefined,
        onCopyTaskLogPath: () => undefined,
        onCopySessionId: () => undefined,
      }),
    ),
  );
}

const COPY_IDS = [
  "appHeader.copyPath",
  "appHeader.copyTaskPath",
  "appHeader.copyLogPath",
  "appHeader.copySessionId",
];

test("四个复制项都在二级菜单内容区内", () => {
  const markup = renderMenu();
  const subContent =
    markup.split('data-slot="task-menu-sub-content"')[1] ??
    assert.fail("缺少 task-menu-sub-content");

  for (const id of COPY_IDS) {
    assert.match(subContent, new RegExp(id), `二级菜单内应包含 ${id}`);
  }
});

test("一级菜单不再平铺复制项，只剩触发器", () => {
  const markup = renderMenu();
  const [topLevel, afterTrigger] = markup.split('data-slot="task-menu-sub-trigger"');
  assert.ok(afterTrigger, "缺少 task-menu-sub-trigger");

  for (const id of COPY_IDS) {
    assert.doesNotMatch(topLevel, new RegExp(id), `一级菜单不应再出现 ${id}`);
  }
  // 触发器文案走 taskList.copyInfo（桩 intl 原样返回 key）。
  const [triggerZone] = afterTrigger.split('data-slot="task-menu-sub-content"');
  assert.match(triggerZone, /taskList\.copyInfo/);
});

test("一级菜单的任务管理动作保持在子菜单之前", () => {
  const markup = renderMenu();
  const [topLevel] = markup.split('data-slot="task-menu-sub-trigger"');

  for (const id of [
    "taskList.pin",
    "taskList.rename",
    "taskList.archive",
    "taskList.markAsUnread",
  ]) {
    assert.match(topLevel, new RegExp(id), `一级菜单应保留 ${id}`);
  }
});
