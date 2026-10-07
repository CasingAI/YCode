import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps, type ReactNode } from "react";
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
  onSelect,
}: {
  children: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}) {
  // 静态渲染没有交互能力，桩在渲染期直接调用 onSelect。
  // 只断言文案不够：文案对了但回调接错，对用户来说仍然是「点下去什么都没发生」。
  onSelect?.();
  return createElement(
    "div",
    { "data-slot": "task-menu-item", "aria-disabled": disabled },
    children,
  );
}

function StubSeparator() {
  return createElement("hr", { "data-slot": "task-menu-separator" });
}

type TaskActionMenuProps = ComponentProps<typeof TaskActionMenuContent>;

function renderMenu(overrides: Partial<TaskActionMenuProps> = {}): string {
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
        ...overrides,
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

/** 一级菜单被分隔线切出的片段，片段数 = 分隔线数 + 1。 */
function topLevelSegments(markup: string): string[] {
  return topLevelBody(markup).split('data-slot="task-menu-separator"');
}

/**
 * 每个分组片段都得有可见条目：片段为空就说明菜单里画了两条相邻的分隔线，
 * 同一个分组边界被画了两遍（窄屏隐藏「在 Finder 中打开」时踩过）。
 * 两端片段各只有一个相邻分隔线，检查非空即可覆盖首尾。
 */
function assertNoAdjacentSeparators(markup: string, expectedCount: number): void {
  const segments = topLevelSegments(markup);
  assert.equal(segments.length - 1, expectedCount, `一级菜单应恰好有 ${expectedCount} 条分隔线`);

  segments.forEach((segment, index) => {
    assert.match(
      segment,
      /data-slot="task-menu-(?:item|sub-trigger)"/,
      `第 ${index + 1} 个分组片段没有可见条目（分隔线 #${index} 之后到 #${index + 1} 之前）`,
    );
  });
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

test("默认形态的三条分隔线各自分隔两个分组", () => {
  assertNoAdjacentSeparators(renderMenu(), 3);
});

test("窄视口隐藏「在 Finder 中打开」后不出现相邻的两条分隔线", () => {
  const narrow = renderMenu({ hideMobileUnsupportedActions: true });

  // 「在 Finder 中打开」独占一个分组，隐藏它时它下方的分隔线必须一起消失，
  // 只剩任务管理分组与「复制信息」「调试」之间的两条。
  assertNoAdjacentSeparators(narrow, 2);
  assert.doesNotMatch(
    topLevelBody(narrow),
    /fileManager/,
    "窄视口一级菜单不应再出现「在 Finder 中打开」",
  );
});

test("已归档时归档行显示「取消归档任务」，未归档时显示「归档任务」", () => {
  // 归档任务结构性不在 timeline 列表里，但它仍可被打开；此时菜单若还写「归档任务」，
  // 点下去只是把 archived 重写成同一个值，用户看到的是「白弹一次确认框，什么也没变」。
  // \w 收尾是为了不误伤 taskList.archiveLocal 这类同前缀 id。
  const archived = renderMenu({ isArchived: true });
  assert.match(archived, /taskList\.unarchive/);
  assert.doesNotMatch(archived, /taskList\.archive(?![\w])/);

  const active = renderMenu();
  assert.match(active, /taskList\.archive(?![\w])/);
  assert.doesNotMatch(active, /taskList\.unarchive/);
});

test("归档行接的回调随归档态切换", () => {
  let archiveCalls = 0;
  let unarchiveCalls = 0;
  const handlers = {
    onArchiveTask: () => {
      archiveCalls += 1;
    },
    onUnarchiveTask: () => {
      unarchiveCalls += 1;
    },
  };

  renderMenu({ ...handlers, isArchived: true });
  assert.equal(unarchiveCalls, 1, "已归档时应调用取消归档");
  assert.equal(archiveCalls, 0, "已归档时不应再调用归档");

  renderMenu(handlers);
  assert.equal(archiveCalls, 1, "未归档时应调用归档");
  assert.equal(unarchiveCalls, 1, "未归档时不应调用取消归档");
});

test("归档态只换文案不换层级：分隔线数量与默认形态一致", () => {
  assertNoAdjacentSeparators(renderMenu({ isArchived: true }), 3);
  assertNoAdjacentSeparators(
    renderMenu({ isArchived: true, hideMobileUnsupportedActions: true }),
    2,
  );
});

test("置顶态 groupMenu 照常渲染「移动到分组」（置顶与分组正交）", () => {
  // 正交语义：isPinned 不再决定子菜单显隐，资格由调用方是否传入 groupMenu 决定。
  // 已置顶的菜单（isPinned: true）传入 groupMenu 时，「移动到分组」触发器与
  // 移出分组/组项/新建分组并移入内容区必须全部存在。
  const markup = renderMenu({
    isPinned: true,
    groupMenu: {
      groups: [{ id: "g1", title: "组一", color: "blue" }],
      currentGroupId: null,
      onMoveToGroup: () => undefined,
      onCreateGroupAndMove: () => undefined,
    },
  });
  const zones = markup.split('data-slot="task-menu-sub-trigger"').slice(1);
  assert.equal(zones.length, 3, "应恰好有三个子菜单触发器");
  assert.match(zones[0], /taskGroup\.moveToGroup/);
  const bodies = subContentBodies(markup);
  assert.match(bodies[0] ?? "", /taskGroup\.removeFromGroup/);
  assert.match(bodies[0] ?? "", /taskGroup\.newGroupAndMove/);
  // 置顶行的置顶/取消置顶文案不受影响。
  assert.match(topLevelBody(markup), /taskList\.unpin/);
});

test("置顶态不传 groupMenu 时仍无「移动到分组」", () => {
  const markup = renderMenu({ isPinned: true });
  assert.doesNotMatch(markup, /taskGroup\.moveToGroup/);
});
