// 思考档位值 → 词条 id 的映射表。单独成文件是因为它有两个约束：
// 1. 「同一档位在多处要说同一个词」——工具条控件、工作流子代理模型标签、行内编辑卡的冻结
//    档位后缀都查这一张表，不得各自复制或直接显示规范值。
// 2. 本模块必须保持无依赖（除类型）：`thoughtLevelOptions.ts` 还要提供 `getThoughtLevelLabel`，
//    那条链会经 `chat-input-toolbar/display.js` 拖进 provider 图标等资源，`node --test` 的纯逻辑
//    用例加载不了 SVG。把表留在这里，工具条之外的消费方就能只引这一张表。

const THOUGHT_LEVEL_LABEL_IDS: Record<string, string> = {
  disabled: "chat.toolbar.thoughtLevel.value.off",
  false: "chat.toolbar.thoughtLevel.value.off",
  no: "chat.toolbar.thoughtLevel.value.off",
  none: "chat.toolbar.thoughtLevel.value.off",
  nothink: "chat.toolbar.thoughtLevel.value.off",
  "no-think": "chat.toolbar.thoughtLevel.value.off",
  no_think: "chat.toolbar.thoughtLevel.value.off",
  off: "chat.toolbar.thoughtLevel.value.off",
  enable: "chat.toolbar.thoughtLevel.value.on",
  enabled: "chat.toolbar.thoughtLevel.value.on",
  on: "chat.toolbar.thoughtLevel.value.on",
  true: "chat.toolbar.thoughtLevel.value.on",
  low: "chat.toolbar.thoughtLevel.value.low",
  minimal: "chat.toolbar.thoughtLevel.value.minimal",
  medium: "chat.toolbar.thoughtLevel.value.medium",
  high: "chat.toolbar.thoughtLevel.value.high",
  "extra-high": "chat.toolbar.thoughtLevel.value.xhigh",
  extra_high: "chat.toolbar.thoughtLevel.value.xhigh",
  xhigh: "chat.toolbar.thoughtLevel.value.xhigh",
  max: "chat.toolbar.thoughtLevel.value.max",
  ultra: "chat.toolbar.thoughtLevel.value.ultra",
};

export function normalizeThoughtLevelText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 档位值 → 词条 id；表里没有的值返回 undefined（调用方原样显示 provider 自己的档位名）。
 * 工具条之外也有人要说这个词（工作流的子代理模型、行内编辑卡的冻结档位），两处必须查同一张表。
 * 用 `Object.hasOwn` 而不是直接索引：provider 若送来 `constructor` 这类原型键名，直接索引会
 * 返回构造函数而不是 undefined。
 */
export function thoughtLevelLabelId(value: string): string | undefined {
  const normalized = normalizeThoughtLevelText(value);
  return Object.hasOwn(THOUGHT_LEVEL_LABEL_IDS, normalized)
    ? THOUGHT_LEVEL_LABEL_IDS[normalized]
    : undefined;
}
