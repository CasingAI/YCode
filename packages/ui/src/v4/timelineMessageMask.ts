// 消息层底部遮罩（composer 遮挡带）的几何裁决（纯函数，无 DOM/React 依赖）。
//
// 遮罩的唯一职责：让消息在 sticky composer dock 的透明留白下方淡出。
// composer dock 自身的 padding 是透明的，消息会从留白里透出来压在输入区上；
// 遮罩把视口底部那一段渐隐掉，于是「消息 → dock」的过渡是干净的。
//
// 尺寸口径：
// - TIMELINE_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX：完全透明区高度，正好盖住 dock
//   的透明留白——这段必须彻底透明，否则消息会透出来压住 dock；
// - TIMELINE_MESSAGE_MASK_FADE_PX：渐隐区高度，负责从「完全不透明」过渡到
//   「完全透明」，没有遮挡物时它没有过渡的对象，所以随遮挡带一起消失。
//
// 关键门控：**只有真的存在 composer dock 时才需要这条遮挡带。**
// 只读面板（子代理详情、WorkflowActor 等）没有 composer，底部没有任何东西遮挡正文，
// 预留的透明带就退化成一段与内容无关的死区：正文被裁成空白，下面留出一截空隙，
// 悬浮圆钮孤零零地落在空白中央。那里没有遮挡物，就不该有遮罩。

/** 渐隐区高度：从不透明过渡到完全透明。 */
export const TIMELINE_MESSAGE_MASK_FADE_PX = 24;

/** 完全透明区高度：盖住 composer dock 的透明留白。 */
export const TIMELINE_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;

export interface TimelineMessageMaskInput {
  /** 视口是否已贴底：贴底时消息位于正常文档流末尾，不会经过 sticky composer。 */
  atBottom: boolean;
  /** 视口高度（滚动容器 clientHeight）。 */
  viewportHeight: number;
  /** 当前面板是否存在 composer dock（底部 sticky 输入区）。 */
  hasComposerDock: boolean;
  /** 消息层顶边相对滚动视口顶边的偏移（scrollTop - messageLayer.offsetTop）。 */
  layerTopOffsetPx: number;
}

export interface TimelineMessageMaskStyle {
  /** CSS mask-image 渐变值。 */
  maskImage: string;
  /** CSS mask-position：与滚动视口对齐。 */
  maskPosition: string;
  /** CSS mask-size：与视口同高。 */
  maskSize: string;
}

/**
 * 消息层底部遮罩样式。
 *
 * 返回 `null` 表示不施加遮罩（调用方写 `mask: none`）。三种不遮罩的情形：
 * 1. 面板没有 composer dock——底部没有遮挡物，遮罩只会凭空吃掉一段正文；
 * 2. 视口已贴底——消息已在正常文档流末尾，不会经过 sticky composer；
 * 3. 视口装不下遮挡带——渐变会退化成"整屏全透明"，等于把正文全部裁掉；
 *    宁可完全不遮罩，也不要让正文整屏消失。
 */
export function resolveTimelineMessageMask(
  input: TimelineMessageMaskInput,
): TimelineMessageMaskStyle | null {
  if (!input.hasComposerDock) return null;
  if (input.atBottom) return null;
  if (!Number.isFinite(input.viewportHeight) || input.viewportHeight <= 0) return null;

  const transparentStart = Math.max(
    0,
    input.viewportHeight - TIMELINE_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
  );
  // 视口比遮挡带还矮时 transparentStart 落到 0，渐变从 0px 起就是透明的——
  // 整屏正文会一起消失。这种视口下 composer 本身也已经无处安放，直接不遮罩。
  if (transparentStart <= 0) return null;

  const opaqueEnd = Math.max(0, transparentStart - TIMELINE_MESSAGE_MASK_FADE_PX);
  const layerTopOffsetPx = Math.max(0, input.layerTopOffsetPx);

  return {
    maskImage: `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`,
    maskPosition: `0 ${layerTopOffsetPx}px`,
    maskSize: `100% ${input.viewportHeight}px`,
  };
}
