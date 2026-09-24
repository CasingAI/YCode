import assert from "node:assert/strict";
import test from "node:test";
import {
  EDIT_FROZEN_MODE_LABEL_CLASS,
  EDIT_FROZEN_MODEL_LABEL_CLASS,
  formatFrozenModelLabelWithLevel,
} from "../src/v4/conversationEditFrozenDisplay.js";

// 行内编辑卡展示 class 的两条不变式：
// 1. 断点必须挂 `conversation` 容器。`@container/composer` 只声明在底部大输入框与设置页自动化
//    输入框上，行内卡与它们是兄弟；命名容器查询没有同名祖先时恒为 false，模式文案曾因此被
//    永久隐藏——这不是响应式取舍，是一个恒假规则。
// 2. 模型名上限必须分档。尾部动作区 `ml-auto shrink-0` 拿不到左侧 `flex-1` 的空白，它自己的
//    `max-w-*` 是唯一生效的约束，写死 192px 就会截断「provider 名 + 模型名 + 档位后缀」。

const TAILWIND_MAX_W_PX: Record<string, number> = {
  "28": 112,
  "48": 192,
  "72": 288,
  "80": 320,
};

function parseBaseMaxW(className: string): number {
  const match = /(?:^|\s)max-w-(\w+)(?:\s|$)/.exec(className);
  assert.ok(match, `应当带一个不带断点前缀的 max-w-* 基准档，实际是：${className}`);
  const px = TAILWIND_MAX_W_PX[match[1]];
  assert.ok(px, `max-w-${match[1]} 不在测试认识的档位表里`);
  return px;
}

function parseLadder(className: string): { minWidthPx: number; maxWidthPx: number }[] {
  const matches = [...className.matchAll(/@min-\[(\d+)px\]\/conversation:max-w-(\w+)/g)];
  return matches.map((match) => ({
    minWidthPx: Number(match[1]),
    maxWidthPx: TAILWIND_MAX_W_PX[match[2]],
  }));
}

test("冻结展示的 class 不引用 composer 容器变体：行内卡不在该容器子树内", () => {
  for (const className of [EDIT_FROZEN_MODE_LABEL_CLASS, EDIT_FROZEN_MODEL_LABEL_CLASS]) {
    assert.equal(
      /\/composer:/.test(className),
      false,
      `挂 composer 容器变体等于恒假规则：${className}`,
    );
  }
});

test("模式文案常显：只按会话列宽度隐藏，不带无条件的 hidden", () => {
  assert.equal(
    EDIT_FROZEN_MODE_LABEL_CLASS.split(/\s+/).includes("hidden"),
    false,
    "无断点前缀的 hidden 会把模式名永久藏掉",
  );
  assert.match(EDIT_FROZEN_MODE_LABEL_CLASS, /@max-\[360px\]\/conversation:hidden/);
  assert.match(EDIT_FROZEN_MODE_LABEL_CLASS, /truncate/);
});

test("模型名宽度阶梯单调不减，断点与上限同步放宽", () => {
  const ladder = parseLadder(EDIT_FROZEN_MODEL_LABEL_CLASS);
  assert.ok(ladder.length > 0, "应当至少有一档随会话列放宽的上限");

  let previous = { minWidthPx: 0, maxWidthPx: parseBaseMaxW(EDIT_FROZEN_MODEL_LABEL_CLASS) };
  for (const step of ladder) {
    assert.ok(step.minWidthPx > previous.minWidthPx, `断点 ${step.minWidthPx}px 应递增`);
    assert.ok(
      step.maxWidthPx > previous.maxWidthPx,
      `${step.minWidthPx}px 档的上限 ${step.maxWidthPx} 应大于上一档 ${previous.maxWidthPx}`,
    );
    previous = step;
  }
});

test("最大一档仍在行内卡 max-w-xl 内：不会把 rewind/×/发送顶出卡外", () => {
  const ladder = parseLadder(EDIT_FROZEN_MODEL_LABEL_CLASS);
  const widest = Math.max(
    parseBaseMaxW(EDIT_FROZEN_MODEL_LABEL_CLASS),
    ...ladder.map((step) => step.maxWidthPx),
  );
  // 行内卡 ChatPromptEditor 传 className="w-full max-w-xl"（36rem = 576px）。
  const CARD_MAX_WIDTH_PX = 576;
  // rewind / 取消 / 发送三个 size-7~icon-md 按钮（各 28px）+ trailing gap-1.5 两次（各 6px）。
  const TRAILING_BUTTONS_PX = 3 * 28 + 2 * 6;
  assert.ok(
    widest + TRAILING_BUTTONS_PX <= CARD_MAX_WIDTH_PX,
    `最宽模型名 ${widest}px 加尾部按钮 ${TRAILING_BUTTONS_PX}px 超出卡片 ${CARD_MAX_WIDTH_PX}px`,
  );
});

test("极窄档在 360px 会话列放得下：模式徽标 + 模型名 + 三个尾部按钮不互相挤爆", () => {
  // 360px 是模式文案仍可见的最窄会话列，也是基础档上限必须成立的算术边界。
  const NARROW_CONVERSATION_PX = 360;
  const CARD_PADDING_PX = 32; // 卡片 px-4 两侧
  const TOOLBAR_GAP_PX = 12; // 工具条 gap-3
  // 图标 16 + 图标与文案间距 4 + 「未知模式」四字文案 + px-2 两侧 16，取最宽的徽标。
  const MODE_BADGE_PX = 92;
  const TRAILING_BUTTONS_PX = 3 * 28 + 3 * 6; // 三个按钮 + trailing gap-1.5 三次
  const available = NARROW_CONVERSATION_PX - CARD_PADDING_PX - TOOLBAR_GAP_PX;
  const used = MODE_BADGE_PX + parseBaseMaxW(EDIT_FROZEN_MODEL_LABEL_CLASS) + TRAILING_BUTTONS_PX;
  assert.ok(
    used <= available,
    `极窄档需要 ${used}px，只有 ${available}px 可用；应收紧 max-w-* 基础档或提前隐藏模式文案`,
  );
});

// 档位后缀必须与工具条说同一个词。`admissionModelSelection.options.reasoningLevel` 存的是规范值
// （high / xhigh / …），直接拼上去会在中文界面显示「· high」，而大输入框的档位控件显示「高」。

/** 假 intl：把词条 id 原样吐出来，断言的是「有没有查映射表」而不是具体译文。 */
const echoIntl = {
  formatMessage: ({ id }: { id: string }) => `<${id}>`,
};

test("档位后缀查工具条同一张映射表：high 不再原样显示", () => {
  assert.equal(
    formatFrozenModelLabelWithLevel({
      modelLabel: "OpenCode Go/Space Bunny Free",
      reasoningLevel: "high",
      intl: echoIntl,
    }),
    "OpenCode Go/Space Bunny Free · <chat.toolbar.thoughtLevel.value.high>",
  );
});

test("映射表里没有的档位原样显示 provider 自己的档位名", () => {
  assert.equal(
    formatFrozenModelLabelWithLevel({
      modelLabel: "GLM 5.3 Flash",
      reasoningLevel: "turbo-3",
      intl: echoIntl,
    }),
    "GLM 5.3 Flash · turbo-3",
  );
});

test("档位为空只留模型名，不留悬空分隔符", () => {
  assert.equal(
    formatFrozenModelLabelWithLevel({
      modelLabel: "GLM 5.3 Flash",
      reasoningLevel: "   ",
      intl: echoIntl,
    }),
    "GLM 5.3 Flash",
  );
});
