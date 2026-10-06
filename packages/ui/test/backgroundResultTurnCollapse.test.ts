import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Collapsible } from "../src/components/ui/collapsible.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ConversationBackgroundResultTitle } from "../src/v4/ConversationTurnGroup.js";

// 后台结果轮（origin=backgroundResult）此前整轮平铺、永远展开，长会话里缩不回去。
// 现在标题行成了折叠触发器，折叠区只盖过程行；唤醒总结正文与后续行留在外面不折叠。
//
// 这里只断言「形态」：有没有 trigger / chevron、标题在不在。展开收起与滚动锚点属于交互层，
// 仓库没有 React 交互测试基建，靠 spec 里的验收场景人工核对。

const TITLE = "后台运行一个每秒输出、持续约 5 分钟的任务";

/** 按真实组合渲染：标题行永远住在 Collapsible 里，trigger 才有 context 可读。 */
function renderTitle(options: {
  open: boolean;
  canCollapse: boolean;
  defaultOpen: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        Collapsible,
        { open: options.open },
        createElement(ConversationBackgroundResultTitle, {
          title: TITLE,
          testIdKey: "turn-background-1",
          open: options.open,
          canCollapse: options.canCollapse,
          defaultOpen: options.defaultOpen,
        }),
      ),
    ),
  );
}

/** Radix 的 CollapsibleTrigger 会把 data-slot 合并到 asChild 的子元素上。 */
function hasTriggerSlot(markup: string): boolean {
  return markup.includes('data-slot="collapsible-trigger"');
}

function chevronRotation(markup: string): string | undefined {
  return /rotate-(0|90)/.exec(markup)?.[1];
}

test("没有过程行时标题行不渲染 trigger，chevron 也不出现", () => {
  const markup = renderTitle({ open: false, canCollapse: false, defaultOpen: false });

  assert.equal(hasTriggerSlot(markup), false, "不可折叠的轮次不应给出点开是空的入口");
  assert.equal(chevronRotation(markup), undefined);
  assert.ok(markup.includes(TITLE), "标题文本必须在");
  assert.ok(markup.includes("chat-background-result-title"), "标题 testId 必须保留");
});

test("可折叠且收起时：渲染 trigger、chevron 指向右", () => {
  const markup = renderTitle({ open: false, canCollapse: true, defaultOpen: false });

  assert.equal(hasTriggerSlot(markup), true);
  assert.equal(chevronRotation(markup), "0");
  assert.ok(markup.includes('data-history-open="false"'));
});

test("可折叠但用户已展开时：chevron 旋转 90 度而不是消失", () => {
  const markup = renderTitle({ open: true, canCollapse: true, defaultOpen: false });

  assert.equal(hasTriggerSlot(markup), true);
  assert.equal(chevronRotation(markup), "90");
  assert.ok(markup.includes('data-history-open="true"'));
});

test("该轮运行中（默认展开）：渲染 trigger 但不画 chevron，点不动", () => {
  const markup = renderTitle({ open: true, canCollapse: true, defaultOpen: true });

  assert.equal(hasTriggerSlot(markup), true, "运行中仍走 Collapsible，只是入口收起");
  assert.equal(chevronRotation(markup), undefined, "默认展开时不画 chevron，与工作段表头一致");
});

test("标题折行时外壳仍是单盒：border-b 与标题在同一个 button 上", () => {
  const markup = renderTitle({ open: false, canCollapse: true, defaultOpen: false });

  assert.ok(markup.includes("<button"), "触发器必须是 button，键盘可达");
  assert.ok(markup.includes("border-b"), "分隔线留在标题行自身，不能被内容顶下去");
  assert.ok(markup.includes("whitespace-pre-wrap"), "长标题继续按原本的折行规则渲染");
});
