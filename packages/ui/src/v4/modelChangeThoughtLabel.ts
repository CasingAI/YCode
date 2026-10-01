// 直接引叶子模块而不是 `thoughtLevelOptions.js`：后者为 `getThoughtLevelLabel` 接着
// `chat-input-toolbar/display.js`，会把 provider 图标等资源拖进本模块的加载链，
// `node --test` 的纯逻辑用例加载不了 SVG。两处查的仍是同一张表。
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabelIds.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * 模型切换分隔线上那截词：模型名后面跟本地化的思考档位。
 *
 * 档位值（`low`/`high`/…）必须查思考控件同一张映射表再本地化，屏幕上不出现规范值——
 * 与编辑冻结显示（`formatFrozenLevelSuffix`）是同一条纪律：同一轮的档位不能在
 * 分隔线上显示成「· high」、在档位控件上显示成「高」。映射表里没有的值原样显示，
 * 那是 provider 自定义的档位名，藏起来比显示更难查。
 *
 * 纯函数 + 注入的 intl：本文件不碰 store、intl 实例与 DOM，node --test 可直接跑。
 */
export function formatModelChangeThoughtLabel(params: {
  modelLabel: string;
  /** marker payload 里的 `toThought`；缺席或空白时只说模型名，不留悬空的分隔符。 */
  thought: string | undefined;
  intl: Pick<IntlInstance, "formatMessage">;
}): string {
  const level = params.thought?.trim();
  if (!level) {
    return params.modelLabel;
  }
  const labelId = thoughtLevelLabelId(level);
  const levelLabel = labelId ? params.intl.formatMessage({ id: labelId }) : level;
  return `${params.modelLabel} · ${levelLabel}`;
}
