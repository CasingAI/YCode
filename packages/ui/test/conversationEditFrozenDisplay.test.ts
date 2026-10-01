import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { ModelSelectGroup } from "../src/ModelConfigSelect.js";
import { encodeCustomModelValue } from "../src/lib/zcodeCustomModelValue.js";
import {
  EDIT_FROZEN_LEVEL_SUFFIX_CLASS,
  EDIT_FROZEN_MODE_LABEL_CLASS,
  EDIT_FROZEN_MODEL_LABEL_CLASS,
  EDIT_FROZEN_MODEL_NAME_CLASS,
  EDIT_FROZEN_PROVIDER_PREFIX_CLASS,
  formatFrozenLevelSuffix,
  resolveFrozenModelSegments,
} from "../src/v4/conversationEditFrozenDisplay.js";

// 行内编辑卡冻结展示（docs/specs/inline-edit-frozen-execution-display.md）的不变式：
// 1. 断点必须挂 `conversation` 容器。`@container/composer` 只声明在底部大输入框与设置页自动化
//    输入框上，行内卡与它们是兄弟；命名容器查询没有同名祖先时恒为 false，模式文案曾因此被
//    永久隐藏——这不是响应式取舍，是一个恒假规则。
// 2. 标签用弹性布局吃掉工具条中部空白（行内编辑卡传 `trailingFlexible`），没有 `max-w-*`
//    上限——弹性和行内卡 `max-w-xl` 封顶就是上限。模型名段是标签里唯一可被截断的段，
//    provider 前缀与档位后缀都是 `shrink-0` 原子段。
// 3. 四段按优先级逐段让位，而不是把文案拼成整串再 truncate。整串在窄列下只能从尾部被砍，
//    屏幕上会只剩「OpenCode Go…」这类只剩 provider 的残段——模型名反而没了。

const ALL_FROZEN_CLASSES = [
  EDIT_FROZEN_MODE_LABEL_CLASS,
  EDIT_FROZEN_PROVIDER_PREFIX_CLASS,
  EDIT_FROZEN_LEVEL_SUFFIX_CLASS,
  EDIT_FROZEN_MODEL_LABEL_CLASS,
  EDIT_FROZEN_MODEL_NAME_CLASS,
];

test("冻结展示的 class 不引用 composer 容器变体：行内卡不在该容器子树内", () => {
  for (const className of ALL_FROZEN_CLASSES) {
    assert.equal(
      /\/composer:/.test(className),
      false,
      `挂 composer 容器变体等于恒假规则：${className}`,
    );
  }
});

test("模式文案只按会话列宽度隐藏，不带无条件的 hidden", () => {
  assert.equal(
    EDIT_FROZEN_MODE_LABEL_CLASS.split(/\s+/).includes("hidden"),
    false,
    "无断点前缀的 hidden 会把模式名永久藏掉",
  );
  assert.match(EDIT_FROZEN_MODE_LABEL_CLASS, /@max-\[480px\]\/conversation:hidden/);
  assert.match(EDIT_FROZEN_MODE_LABEL_CLASS, /truncate/);
});

test("档位后缀是原子段：不可压缩也不可截断，480px 以下整段隐藏", () => {
  // `shrink-0` 让挤压全部由模型名段吸收，屏幕上不出现无意义的 `· ...`。
  assert.match(EDIT_FROZEN_LEVEL_SUFFIX_CLASS, /(^|\s)shrink-0(\s|$)/);
  assert.equal(
    /truncate/.test(EDIT_FROZEN_LEVEL_SUFFIX_CLASS),
    false,
    "后缀带 truncate 会把它自己也截成残段",
  );
  // 后缀是独立 flex 子项，字符串前导空格会被折叠（`Free· 最高` 的粘连即由此来）；
  // 与模型名之间的间距用 `ml-1`。
  assert.match(EDIT_FROZEN_LEVEL_SUFFIX_CLASS, /(^|\s)ml-1(\s|$)/);
  assert.match(EDIT_FROZEN_LEVEL_SUFFIX_CLASS, /@max-\[480px\]\/conversation:hidden/);
  assert.equal(
    EDIT_FROZEN_LEVEL_SUFFIX_CLASS.split(/\s+/).includes("hidden"),
    false,
    "档位后缀必须常驻，只在断点下隐藏",
  );
});

test("provider 前缀默认隐藏、1024px 起显示：方向与模式文案相反", () => {
  // 与大输入框胶囊的 `hidden @2xl/composer:inline` 同构。用「默认隐藏 + 断点显示」而不是
  // `@max-[1023px]` 隐藏：后者会和 `@min-[1024px]` 在边界同时命中。
  // 1024px 是纯政策位：行内卡在 576px 早已封顶，阈值只决定「多宽才配显示身份信息」。
  assert.match(EDIT_FROZEN_PROVIDER_PREFIX_CLASS, /(^|\s)hidden(\s|$)/);
  assert.match(EDIT_FROZEN_PROVIDER_PREFIX_CLASS, /@min-\[1024px\]\/conversation:inline/);
  assert.equal(
    /@max-\[1023px\]/.test(EDIT_FROZEN_PROVIDER_PREFIX_CLASS),
    false,
    "隐藏侧不得用 max 断点，避免与显隐阈值在边界对撞",
  );
  // 前缀整段显隐，不该被逐字截断成半截 provider 名。
  assert.match(EDIT_FROZEN_PROVIDER_PREFIX_CLASS, /shrink-0/);
});

test("标签根节点弹性填满：没有 max-w 上限，按钮区靠结构钉在右侧", () => {
  // 上限不再需要——弹性和行内卡 `max-w-xl` 封顶就是上限。`justify-end` 让标签内容
  // 贴着 rewind 按钮向左伸展、剩下的空白留在模式徽标与标签之间——与底部大输入框
  // 的模型胶囊同一条纪律（胶囊是 trailing 区的右钉元素，中部空白永远在它左边）。
  // `justify-start` 在这里是错的：它把模型名推到徽标边、空白留在标签与按钮之间，
  // 看起来“吃掉了空白”，实际是把标签和按钮撕成了两截（真机截图翻车过）。
  // `min-w-0` 让收缩能传进内段。
  assert.match(EDIT_FROZEN_MODEL_LABEL_CLASS, /(^|\s)flex-1(\s|$)/);
  assert.match(EDIT_FROZEN_MODEL_LABEL_CLASS, /(^|\s)min-w-0(\s|$)/);
  assert.match(EDIT_FROZEN_MODEL_LABEL_CLASS, /(^|\s)justify-end(\s|$)/);
  assert.equal(
    /(^|\s)justify-start(\s|$)/.test(EDIT_FROZEN_MODEL_LABEL_CLASS),
    false,
    "根节点左对齐会把标签和按钮撕成两截",
  );
  assert.equal(
    /max-w-/.test(EDIT_FROZEN_MODEL_LABEL_CLASS),
    false,
    "根节点带 max-w-* 会重新锁死宽度，弹性布局失效",
  );
});

test("模型名段只收缩不伸展：伸展吃空白是根节点的事", () => {
  // 模型名段一旦带 `flex-1`，就会把档位后缀推到右边缘，屏幕上出现
  // 「模型名……空一大截……· 中」的断裂（窄列实测翻车过）。
  assert.match(EDIT_FROZEN_MODEL_NAME_CLASS, /(^|\s)min-w-0(\s|$)/);
  assert.match(EDIT_FROZEN_MODEL_NAME_CLASS, /(^|\s)truncate(\s|$)/);
  assert.equal(
    /(^|\s)flex-1(\s|$)/.test(EDIT_FROZEN_MODEL_NAME_CLASS),
    false,
    "模型名段伸展会把档位后缀推到右边缘",
  );
});

test("按钮永远钉在右侧：标签里只有一个 min-w-0 段可收缩", () => {
  // rewind/×/发送是固定宽度按钮。标签根节点 `min-w-0` 只负责把收缩传进内段；
  // 内段里只有模型名段是 `shrink` 默认 + `min-w-0`，provider 前缀与档位后缀都是
  // `shrink-0`——挤压不可能先砍按钮。
  for (const className of [EDIT_FROZEN_PROVIDER_PREFIX_CLASS, EDIT_FROZEN_LEVEL_SUFFIX_CLASS]) {
    assert.match(className, /(^|\s)shrink-0(\s|$)/);
  }
  assert.equal(
    /shrink-0/.test(EDIT_FROZEN_MODEL_NAME_CLASS),
    false,
    "模型名段带 shrink-0 会拒绝收缩，把按钮顶出卡外",
  );
});

test("每档的算术余量都成立：弹性剩多少模型名用多少，尾部按钮不被顶出", () => {
  const CARD_PADDING_PX = 32; // 卡片 px-4 两侧
  const TOOLBAR_GAP_PX = 12; // 工具条 gap-3
  const TRAILING_BUTTONS_PX = 3 * 28 + 3 * 6; // rewind/×/发送 + trailing gap-1.5 三次
  const MODE_BADGE_ICON_PX = 32; // 480px 以下模式文案隐藏，只剩图标 16 + px-2 两侧 16
  const MODE_BADGE_TEXT_PX = 92; // 模式文案可见时的最宽徽标：图标 16 + 间距 4 + 四字 + px-2 两侧 16
  const LEVEL_SUFFIX_PX = 64; // `· 最高` 二字 + ml-1，取整

  const tiers = [
    // 480px 以下后缀与 provider 都已让位，只剩「模式图标 + 模型名 + 尾部按钮」。
    { columnPx: 360, badgePx: MODE_BADGE_ICON_PX, suffixPx: 0 },
    // 480–1023px：模式文案回来，provider 仍隐藏，后缀原子显示。
    { columnPx: 480, badgePx: MODE_BADGE_TEXT_PX, suffixPx: LEVEL_SUFFIX_PX },
    { columnPx: 1023, badgePx: MODE_BADGE_TEXT_PX, suffixPx: LEVEL_SUFFIX_PX },
    // 1024px 起 provider 回来；卡片 576px 封顶，几何不再变化。
    { columnPx: 1280, badgePx: MODE_BADGE_TEXT_PX, suffixPx: LEVEL_SUFFIX_PX },
  ];

  for (const tier of tiers) {
    const cardPx = Math.min(tier.columnPx, 576);
    const available = cardPx - CARD_PADDING_PX - TOOLBAR_GAP_PX;
    const fixedPx = tier.badgePx + tier.suffixPx + TRAILING_BUTTONS_PX;
    // 弹性下不断言模型名具体宽度，只断言固定部分之后还剩正数可用——剩多少模型名用多少。
    assert.ok(
      available - fixedPx > 0,
      `${tier.columnPx}px 会话列固定部分占 ${fixedPx}px，只有 ${available}px 可用`,
    );
  }
});

// 档位后缀必须与工具条、模型切换分隔线说同一个词。`admissionModelSelection.options.reasoningLevel`
// 存的是规范值（high / xhigh / …），直接拼上去会在中文界面显示「· high」，而大输入框的档位控件
// 显示「高」——同一轮冻结值出现两套文案。

/** 假 intl：把词条 id 原样吐出来，断言的是「有没有查映射表」而不是具体译文。 */
const echoIntl = {
  formatMessage: ({ id }: { id: string }) => `<${id}>`,
};

test("档位后缀查工具条同一张映射表：high 不再原样显示", () => {
  // 后缀不带前导空格：渲染侧用 `ml-1` 间距，不依赖会被折叠的字符串空格。
  assert.equal(
    formatFrozenLevelSuffix("high", echoIntl),
    "· <chat.toolbar.thoughtLevel.value.high>",
  );
});

test("映射表里没有的档位原样显示 provider 自己的档位名", () => {
  assert.equal(formatFrozenLevelSuffix("turbo-3", echoIntl), "· turbo-3");
});

test("档位为空只留空串，不留悬空分隔符", () => {
  assert.equal(formatFrozenLevelSuffix("   ", echoIntl), "");
});

// 三段解析：模型名必须永远是独立的一段。退化形态是把 `fullLabel` 写回模型名字段——那样
// 窄列下就再没有「只显示模型名」这个选项，截断结果会变成只剩 provider 的残段。

const CUSTOM_PROVIDER_ID = "opencode-go-chat";
const FALLBACK_LABEL = "选择模型";

function buildGroups(providerId: string, modelIds: readonly string[]): ModelSelectGroup[] {
  return [
    {
      key: `registry-provider:${providerId}`,
      label: providerId,
      items: modelIds.map((modelId) => ({
        key: `registry-provider:${providerId}:${modelId}`,
        value: encodeCustomModelValue(providerId, modelId),
        name: modelId,
      })),
    },
  ];
}

function resolveSegments(options?: {
  providerId?: string;
  providerName?: string;
  modelId?: string;
  reasoningLevel?: string;
  catalogModelIds?: readonly string[];
}) {
  const providerId = options?.providerId ?? CUSTOM_PROVIDER_ID;
  const modelId = options?.modelId ?? "space-bunny-free";
  return resolveFrozenModelSegments({
    modelGroups: buildGroups(providerId, options?.catalogModelIds ?? [modelId]),
    normalizedValue: encodeCustomModelValue(providerId, modelId),
    providerId,
    providerName: options?.providerName,
    fallbackLabel: FALLBACK_LABEL,
    reasoningLevel: options?.reasoningLevel,
    intl: echoIntl,
  });
}

test("带档位的一轮：模型名仍是独立一段，完整标签只给 tooltip", () => {
  const segments = resolveSegments({ providerName: "OpenCode Go", reasoningLevel: "high" });
  assert.equal(segments.providerPrefix, "OpenCode Go/");
  assert.equal(segments.modelLabel, "Space Bunny Free");
  assert.equal(segments.levelSuffix, "· <chat.toolbar.thoughtLevel.value.high>");
  assert.equal(
    segments.fullLabel,
    "OpenCode Go/Space Bunny Free · <chat.toolbar.thoughtLevel.value.high>",
  );
  assert.equal(segments.isFallback, false);
});

test("模型名段永远不含 provider：窄列才有「只显示模型名」这个选项", () => {
  const segments = resolveSegments({ providerName: "OpenCode Go", reasoningLevel: "high" });
  assert.equal(
    segments.modelLabel.includes("OpenCode Go"),
    false,
    "模型名段混入 provider 前缀，窄列下整串截断就只剩 provider 残段",
  );
  assert.equal(
    segments.fullLabel,
    `${segments.providerPrefix ?? ""}${segments.modelLabel} ${segments.levelSuffix}`,
    "完整标签必须等于三段拼起来（可视后缀靠 ml-1 间距），tooltip 才与可见内容一致",
  );
});

test("无档位的一轮：后缀是空串，模型名不悬空任何分隔符", () => {
  const segments = resolveSegments({ providerName: "OpenCode Go" });
  assert.equal(segments.levelSuffix, "");
  assert.equal(segments.fullLabel, "OpenCode Go/Space Bunny Free");
});

test("内置家族不拼 provider 前缀，也不渲染空节点", () => {
  const segments = resolveSegments({
    providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    providerName: "Z.ai",
    modelId: "glm-5.3-flash",
  });
  assert.equal(segments.providerPrefix, undefined);
  assert.equal(segments.modelLabel, "GLM 5.3 Flash");
});

test("provider 名称为空白时不拼前缀", () => {
  const segments = resolveSegments({ providerName: "   " });
  assert.equal(segments.providerPrefix, undefined);
  assert.equal(segments.modelLabel, "Space Bunny Free");
});

test("目录未命中：整段回落占位，不分段、不挂档位后缀", () => {
  const segments = resolveSegments({
    providerName: "OpenCode Go",
    reasoningLevel: "high",
    modelId: "已下线_模型",
    catalogModelIds: ["space-bunny-free"],
  });
  assert.equal(segments.isFallback, true);
  assert.equal(segments.providerPrefix, undefined);
  assert.equal(segments.modelLabel, FALLBACK_LABEL);
  assert.equal(segments.levelSuffix, "");
  assert.equal(segments.fullLabel, FALLBACK_LABEL);
});
