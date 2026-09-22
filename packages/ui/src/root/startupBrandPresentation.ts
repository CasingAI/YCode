// 同目录相对导入：模型要被 packages/ui/test 下的 node:test 直接加载，`@/` 别名在那里解析不了。
import { STARTUP_BRAND_FACES } from "./startupBrandTiming.js";

export type StartupBrandMode = "emojiSequence" | "staticFace";

export interface StartupBrandPresentation {
  /** 参与轮播的字形。阶段 2 为空数组——收尾时一个字形都不该留在屏幕上。 */
  faces: readonly string[];
  /** 轮播动画是否在跑。只有阶段 1 为真。 */
  cycling: boolean;
  /** 是否显示阶段 2 的 App 图标位图。 */
  badgeVisible: boolean;
}

/**
 * 启动品牌的两阶段形态：阶段 1 是裸字形轮播，阶段 2 是 App 图标位图。
 *
 * 两者必须互斥。图标自带黑色圆角底，一旦与字形同屏（或静止出现在轮播里），
 * 浅色系统材质下会被读成「表情外面围了一圈很粗的边框」——这正是回归要防的观感。
 * 因此字形与图标不出现在同一个 presentation 里，组件只按它写 DOM 属性。
 */
export function resolveStartupBrandPresentation(
  mode: StartupBrandMode,
  settled: boolean,
): StartupBrandPresentation {
  // 迁移与失败态可能长时间停留，既不属于阶段 1 也不属于阶段 2：
  // 只给首帧静态字形，不给轮播，也不给「已就绪」的图标位图。
  if (mode === "staticFace") {
    return { faces: STARTUP_BRAND_FACES.slice(0, 1), cycling: false, badgeVisible: false };
  }
  return settled
    ? { faces: [], cycling: false, badgeVisible: true }
    : { faces: STARTUP_BRAND_FACES, cycling: true, badgeVisible: false };
}
