import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 触屏端（hover: none）既没有指针悬停也没有 Tab 键，group-hover/* 与 focus-within
// 两条显形路径都不成立。操作行如果只带降噪基线，复制/编辑入口会永久停在 opacity-0。
// 这里锁的是「触屏常驻 + 桌面降噪」两条规则必须同时存在于每一条渲染路径上。

const rowViewSource = readFileSync(
  new URL("../src/v4/ConversationRowView.tsx", import.meta.url),
  "utf8",
);
const turnGroupSource = readFileSync(
  new URL("../src/v4/ConversationTurnGroup.tsx", import.meta.url),
  "utf8",
);

const TOUCH_PERSISTENT = "[@media(hover:none)]:opacity-100";

interface ActionRowCase {
  name: string;
  source: string;
  /** 源码里应当原样出现的完整类名串（降噪基线 + 触屏常驻）。 */
  className: string;
  /** 该行必须保留的桌面降噪/显形类名，缺一个就是降噪被误删。 */
  desktopUtilities: readonly string[];
}

const ACTION_ROWS: readonly ActionRowCase[] = [
  {
    name: "用户气泡下方的复制/编辑行",
    source: rowViewSource,
    className:
      "opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
    desktopUtilities: ["opacity-0", "group-hover/user-row:opacity-100", "focus-within:opacity-100"],
  },
  {
    name: "助手行级操作行",
    source: rowViewSource,
    className:
      "opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
    desktopUtilities: [
      "opacity-0",
      "group-hover/assistant-row:opacity-100",
      "focus-within:opacity-100",
    ],
  },
  {
    name: "助手轮级操作行",
    source: turnGroupSource,
    className:
      "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
    desktopUtilities: [
      "opacity-0",
      "group-hover/assistant-turn:opacity-100",
      "focus-within:opacity-100",
    ],
  },
];

test("每条消息操作行渲染路径都带触屏常驻变体", () => {
  for (const row of ACTION_ROWS) {
    assert.ok(
      row.source.includes(row.className),
      `${row.name} 缺少 ${TOUCH_PERSISTENT}：触屏端会永久停在 opacity-0`,
    );
  }
});

test("触屏常驻不得顶掉桌面降噪基线", () => {
  for (const row of ACTION_ROWS) {
    for (const utility of row.desktopUtilities) {
      assert.ok(row.className.includes(utility), `${row.name} 丢失桌面端类名 ${utility}`);
    }
  }
});

test("触屏变体排在降噪基线之后，媒体查询内才能覆盖 opacity-0", () => {
  // Tailwind 把变体排在基础工具类之后；顺序反了媒体查询里的 opacity-100 会被后面的
  // opacity-0 盖掉，表现为「类名加了但仍然看不见」。
  for (const row of ACTION_ROWS) {
    assert.ok(
      row.className.lastIndexOf(TOUCH_PERSISTENT) > row.className.indexOf("opacity-0"),
      `${row.name} 的触屏变体必须写在 opacity-0 之后`,
    );
  }
});

test("助手操作行两条渲染路径同源，不允许只改一条", () => {
  // 行级（ConversationRowView）与轮级（ConversationTurnGroup）承载同一枚按钮，
  // 由 hideActions / deferActions 裁决走哪条；只改一条会让显隐行为随分支漂。
  const rowLevel = ACTION_ROWS.find((row) => row.name === "助手行级操作行");
  const turnLevel = ACTION_ROWS.find((row) => row.name === "助手轮级操作行");
  assert.ok(rowLevel && turnLevel);

  for (const row of [rowLevel, turnLevel]) {
    assert.ok(row.className.endsWith(TOUCH_PERSISTENT), `${row.name} 必须带 ${TOUCH_PERSISTENT}`);
  }
});
