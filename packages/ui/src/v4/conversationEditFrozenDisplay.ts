// 直接引叶子模块而不是 `thoughtLevelOptions.js`：后者为 `getThoughtLevelLabel` 接着
// `chat-input-toolbar/display.js`，会把 provider 图标等资源拖进本模块的加载链，
// `node --test` 的纯逻辑用例加载不了 SVG。两处查的仍是同一张表。
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabelIds.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

// 行内编辑卡「冻结执行选择」只读展示的布局决策。
//
// 断点一律挂 `conversation` 容器：行内编辑卡渲染在会话流内，真实祖先是 SessionPane 的
// `@container/conversation`。`@container/composer` 只声明在底部大输入框与设置页自动化输入框，
// 行内卡与它们是兄弟而非父子——命名容器查询在没有同名祖先时恒为 false，挂了 composer 变体
// 等于把文案永久隐藏（模式文案曾因此在任何宽度下都不显示）。
//
// 模型名的上限必须分档而不是直接删掉：尾部动作区是 `ml-auto shrink-0`，左侧 leadingActions
// 才是 `flex-1`，模型名借不到左侧空白，它自己的 `max-w-*` 是唯一生效的约束。行内卡自身
// `max-w-xl`（576px）仍是天花板，最大一档 320px 加上 rewind/×/发送与内边距仍在卡内。

/** 模式文案：常显，极窄会话列（<360px）回落为纯图标，与 ToolSummaryRow 同一口径。 */
export const EDIT_FROZEN_MODE_LABEL_CLASS = "truncate @max-[360px]/conversation:hidden";

/**
 * 模型名宽度阶梯：随会话列变宽逐级放宽，避免固定 192px 上限截断长 provider 名 + 档位后缀。
 * 基础档取 112px 是极窄列的算术余量：360px 会话列减去卡片 px-4 与工具条 gap-3 后约 316px，
 * 留给「模式徽标（约 92px）+ 模型名 + rewind/×/发送（102px）+ trailing 间距（18px）」刚好不溢出。
 */
export const EDIT_FROZEN_MODEL_LABEL_CLASS =
  "max-w-28 @min-[624px]/conversation:max-w-48 @min-[864px]/conversation:max-w-72 @min-[1280px]/conversation:max-w-80";

/**
 * 模型名 + 思考档位后缀。档位必须查工具条同一张映射表（`thoughtLevelLabelId`）再本地化：
 * `admissionModelSelection.options.reasoningLevel` 存的是规范值 `high`，直接拼上去会在中文
 * 界面显示成「· high」，而大输入框的档位控件显示「高」——同一轮冻结值出现两套文案。
 * 映射表里没有的值原样显示 provider 自己的档位名，与工具条行为一致。
 */
export function formatFrozenModelLabelWithLevel(params: {
  modelLabel: string;
  reasoningLevel: string;
  intl: Pick<IntlInstance, "formatMessage">;
}): string {
  const level = params.reasoningLevel.trim();
  if (!level) {
    return params.modelLabel;
  }
  const labelId = thoughtLevelLabelId(level);
  const levelLabel = labelId ? params.intl.formatMessage({ id: labelId }) : level;
  return `${params.modelLabel} · ${levelLabel}`;
}
