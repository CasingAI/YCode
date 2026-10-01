// 直接引叶子模块而不是 `thoughtLevelOptions.js`：后者为 `getThoughtLevelLabel` 接着
// `chat-input-toolbar/display.js`，会把 provider 图标等资源拖进本模块的加载链，
// `node --test` 的纯逻辑用例加载不了 SVG。档位后缀与模型切换分隔线共用
// `modelChangeThoughtLabel.js` 的拼装，那份同样只引 `thoughtLevelLabelIds.js` 这张叶子表；
// 两处查的仍是同一张表。
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { resolveV4ModelTriggerDisplay } from "@/v4/composer/modelTriggerDisplay.js";
import { formatModelChangeThoughtLabel } from "@/v4/modelChangeThoughtLabel.js";

// 行内编辑卡「冻结执行选择」只读展示的布局决策。
//
// 断点一律挂 `conversation` 容器：行内编辑卡渲染在会话流内，真实祖先是 SessionPane 的
// `@container/conversation`。`@container/composer` 只声明在底部大输入框与设置页自动化输入框，
// 行内卡与它们是兄弟而非父子——命名容器查询在没有同名祖先时恒为 false，挂了 composer 变体
// 等于把文案永久隐藏（模式文案曾因此在任何宽度下都不显示）。
//
// 行内编辑卡传 `trailingFlexible`：leading 外层从 `flex-1` 收成 `shrink-0`（只装模式徽标），
// trailing 从 `ml-auto shrink-0` 换成 `min-w-0 flex-1`，冻结标签根节点再 `flex-1`——标签向左
// 伸展吃掉工具条中部空白。标签没有 `max-w-*` 上限：弹性和行内卡自身 `max-w-xl`（576px）封顶
// 就是上限，宽列时完整标签能显示多少显示多少；模型名内段是唯一的弹性收缩段，挤压只砍它。
//
// 四段按「模型名 > 档位后缀 > provider 前缀 > 模式文案」的优先级逐段让位。把 provider 与模型名
// 预先拼成单一字符串再 truncate 是行不通的：窄列下整串只能从尾部被砍，砍掉的正是还认得出的
// 那部分，屏幕上只剩「OpenCode Go…」。分段之后才能先舍 provider、留住模型名——与大输入框
// 胶囊在同一条纪律上（见 modelTriggerDisplay.ts 的结构化前缀约定）。

/**
 * 模式文案：会话列窄于 480px 回落为纯图标，与 `ToolSummaryRow` 的 `@max-[360px]/conversation:hidden`
 * 同一口径，只是阈值更高——让出的约 60px 归模型名，否则窄列下模型名会被截成「Space Bunn…」。
 * 图标始终存在，模式身份不丢；文案值由 tooltip 承载。
 */
export const EDIT_FROZEN_MODE_LABEL_CLASS = "truncate @max-[480px]/conversation:hidden";

/**
 * provider 前缀：默认隐藏，1024px 起显示。写法与大输入框胶囊的 `hidden @2xl/composer:inline`
 * 同构——用「默认隐藏 + 断点显示」而不是 `@max-[1023px]` 隐藏，避免边界上两条规则同时命中。
 * 1024px 是纯政策位：行内卡在会话列约 635px 即到达自身 576px 封顶，此后卡片几何不再变化，
 * 阈值设多高都不影响卡片，只决定「多宽才配显示身份信息」；624–1023px 的全部空间归模型名。
 */
export const EDIT_FROZEN_PROVIDER_PREFIX_CLASS =
  "shrink-0 truncate hidden @min-[1024px]/conversation:inline";

/**
 * 档位后缀（` · 高`）：原子段，不可压缩也不可截断——要么完整显示，要么在 480px 以下整段
 * 隐藏。`shrink-0` 让它成为原子：挤压全部由模型名段吸收，屏幕上不出现无意义的 `· ...`。
 * 与模型名之间的间距用 `ml-1`：后缀是独立 flex 子项，字符串前导空格会被浏览器折叠，
 * `Free· 最高` 的粘连即由此来。被隐藏时完整值仍可从 tooltip 读到。
 */
export const EDIT_FROZEN_LEVEL_SUFFIX_CLASS = "ml-1 shrink-0 @max-[480px]/conversation:hidden";

/**
 * 冻结标签根节点：`flex-1` 向左伸展吃掉 trailing 动作区的剩余宽度，没有 `max-w-*` 上限——
 * 弹性和行内卡 `max-w-xl`（576px）封顶就是上限。内容一律右对齐（`justify-end`）：贴着
 * rewind 按钮向左伸展，剩下的空白留在模式徽标与标签之间——与底部大输入框的模型胶囊
 * 同一条纪律（胶囊是 trailing 区的右钉元素，中部空白永远在它左边）。
 * `justify-start` 在这里是错的：它把模型名推到徽标边、空白留在标签与按钮之间，
 * 看起来“吃掉了空白”，实际是把标签和按钮撕成了两截（真机截图翻车过）。
 * 模型名内段（`min-w-0 truncate`）是标签里唯一可被截断的段；provider 前缀与档位后缀
 * 都是 `shrink-0` 原子段。宽列下内容天然贴边，无对齐问题；窄列下收缩只砍模型名段，
 * 后缀与 provider 按断点整段显隐，不存在“从哪边截”的方向问题。
 * 在 `FrozenModelLabel` 里与 `inline-flex h-7 min-w-0 items-center px-1 …` 叠加使用。
 */
export const EDIT_FROZEN_MODEL_LABEL_CLASS = "min-w-0 flex-1 justify-end truncate";

/**
 * 模型名段：只收缩、不伸展。`min-w-0` 让它在 flex 行里可被压缩（否则内容宽度会把按钮
 * 顶出卡外），`truncate` 让压缩只砍它一个——provider 前缀与档位后缀不受影响。
 * 刻意不用 `flex-1`：伸展吃空白是根节点的事；模型名段一旦伸展，就会把档位后缀推到
 * 右边缘，屏幕上出现「模型名……空一大截……· 中」的断裂（窄列实测翻车过）。
 */
export const EDIT_FROZEN_MODEL_NAME_CLASS = "min-w-0 truncate";

/**
 * 档位后缀（`· 高`，不带前导空格），无档位时是空串。
 *
 * 与模型切换分隔线共用同一处拼装：分隔线和冻结标签是同一轮档位的两处出口，词句必须同源。
 * 共用函数以空基串调用会产出 ` · 高`，这里去掉前导空格——渲染侧以后缀独立 span +
 * `ml-1` 做间距，不依赖字符串里的空格（块首空格会被浏览器折叠）；`fullLabel` 拼装时
 * 再补回那一个空格，tooltip 里的写法保持 `模型 · 档位`。
 */
export function formatFrozenLevelSuffix(
  reasoningLevel: string,
  intl: Pick<IntlInstance, "formatMessage">,
): string {
  return formatModelChangeThoughtLabel({
    modelLabel: "",
    thought: reasoningLevel,
    intl,
  }).trimStart();
}

export interface FrozenModelSegments {
  /** `<providerName>/`；内置家族、provider 名缺失时不返回，不渲染空节点。 */
  providerPrefix: string | undefined;
  /** 排版后的模型名，任何宽度下都保留，标签里唯一可被截断的段。 */
  modelLabel: string;
  /** `· <档位>`（渲染侧用 `ml-1` 做间距，不依赖前导空格）；无档位时为空串。 */
  levelSuffix: string;
  /** 三段拼成的完整标签，只给 tooltip / aria-label，不直接进可见文本。 */
  fullLabel: string;
  /** 目录未就绪或未命中：整串回落占位，不分段渲染。 */
  isFallback: boolean;
}

/**
 * 把冻结的 modelSelection 解析成三段可独立控制可见性的文案。
 *
 * 目录命中与否决定要不要分段：占位（「选择模型」/ 旧 snapshot 回落）不是模型名，套上分段只会
 * 留下一截悬空的 provider 位。命中时模型名段永远与 provider 前缀分开——这一段是整条链最容易
 * 退化的地方：早先把 `fullLabel` 写回模型名字段，窄列下就再没有「只显示模型名」这个选项了。
 */
export function resolveFrozenModelSegments(params: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  providerId: string | undefined;
  providerName: string | undefined;
  fallbackLabel: string;
  reasoningLevel: string | undefined;
  intl: Pick<IntlInstance, "formatMessage">;
}): FrozenModelSegments {
  const resolved = resolveV4ModelTriggerDisplay({
    modelGroups: params.modelGroups,
    normalizedValue: params.normalizedValue,
    fallbackLabel: params.fallbackLabel,
    providerId: params.providerId,
    providerName: params.providerName,
  });
  if (resolved.fullLabel === params.fallbackLabel) {
    return {
      providerPrefix: undefined,
      modelLabel: params.fallbackLabel,
      levelSuffix: "",
      fullLabel: params.fallbackLabel,
      isFallback: true,
    };
  }
  const levelSuffix = formatFrozenLevelSuffix(params.reasoningLevel ?? "", params.intl);
  return {
    providerPrefix: resolved.providerPrefix,
    modelLabel: resolved.modelLabel,
    levelSuffix,
    // tooltip 里的写法保持 `模型 · 档位`（带空格），可见后缀 span 靠 `ml-1` 间距。
    fullLabel: levelSuffix ? `${resolved.fullLabel} ${levelSuffix}` : resolved.fullLabel,
    isFallback: false,
  };
}
