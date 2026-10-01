import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TaskActionMenuContent } from "../src/TaskActionMenuContent.js";

/**
 * 「复制信息」和「调试」两个二级菜单的结构回归。
 *
 * Radix 真组件在服务端静态渲染时不输出关闭的子菜单内容，
 * 这里用桩组件替换 Sub 三件套：Sub 只透传 children，
 * SubTrigger 与 SubContent 包一层带 data-slot 的普通标签，
 * 让静态渲染能看到全部内容，进而断言各动作落在哪一层。
 *
 * 顺序约定：「复制信息」在前、「调试」在后，与 TaskActionMenuContent 里的渲染顺序一致。
 */
function StubSub({ children }: { children?: ReactNode }) {
  return createElement("div", null, children);
}

function StubSubTrigger({ children }: { children: ReactNode }) {
  return createElement("div", { "data-slot": "task-menu-sub-trigger" }, children);
}

function StubSubContent({ children }: { children?: ReactNode }) {
  // 首尾各一个标记：只靠起始标记切分时，最后一个子菜单的正文会落进「起始标记之后」的
  // 片段里，剥不掉，用双标记才能把子菜单正文完整摘出来。
  return createElement(
    "div",
    { "data-slot": "sub-content" },
    createElement("div", { "data-slot": "sub-content-end" }, children),
  );
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
  // 桩 intl 原样返回 key：断言的是 id 落点，不依赖语言包；
  // 真实文案（zh-CN「复制信息」「调试」）由语言包文件承载，typecheck 守住 key 存在。
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
        onViewModelTrajectory: () => undefined,
        onOpenTaskFeedback: () => undefined,
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

const DEBUG_IDS = ["taskList.viewModelTrajectory", "taskList.feedback"];

const SUB_CONTENT_RE =
  /<div data-slot="sub-content"><div data-slot="sub-content-end">([\s\S]*?)<\/div><\/div>/g;

/** 各级子菜单内容区的正文，按渲染顺序；子菜单触发器本身不在其中。 */
function subContentBodies(markup: string): string[] {
  return [...markup.matchAll(SUB_CONTENT_RE)].map((match) => match[1]);
}

/** 剥掉全部子菜单内容区后剩下的部分，即一级菜单正文。 */
function topLevelBody(markup: string): string {
  return markup.replace(SUB_CONTENT_RE, "");
}

test("四个复制项都在「复制信息」子菜单内", () => {
  const [copySub] = subContentBodies(renderMenu());
  assert.ok(copySub, "缺少第一个子菜单内容区");

  for (const id of COPY_IDS) {
    assert.match(copySub, new RegExp(id), `「复制信息」内应包含 ${id}`);
  }
});

test("两项诊断动作都在「调试」子菜单内", () => {
  const bodies = subContentBodies(renderMenu());
  const debugSub = bodies[1];
  assert.ok(debugSub, "缺少第二个子菜单内容区");

  for (const id of DEBUG_IDS) {
    assert.match(debugSub, new RegExp(id), `「调试」内应包含 ${id}`);
  }
});

test("一级菜单不再平铺任何子菜单条目", () => {
  const topLevel = topLevelBody(renderMenu());

  for (const id of [...COPY_IDS, ...DEBUG_IDS]) {
    assert.doesNotMatch(topLevel, new RegExp(id), `一级菜单不应再出现 ${id}`);
  }
});

test("两个子菜单触发器都在一级，且各自带正确文案", () => {
  const zones = renderMenu().split('data-slot="task-menu-sub-trigger"').slice(1);
  assert.equal(zones.length, 2, "应恰好有两个子菜单触发器");
  assert.match(zones[0], /taskList\.copyInfo/);
  assert.match(zones[1], /taskList\.debug/);
});

test("一级菜单的任务管理动作保持在子菜单之前", () => {
  const [topLevel] = renderMenu().split('data-slot="task-menu-sub-trigger"');

  for (const id of [
    "taskList.pin",
    "taskList.rename",
    "taskList.archive",
    "taskList.markAsUnread",
  ]) {
    assert.match(topLevel, new RegExp(id), `一级菜单应保留 ${id}`);
  }
});
