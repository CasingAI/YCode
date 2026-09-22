/** 阶段 1 的帧序。四帧共享一个周期，靠逐帧递增的正延迟错开相位（见 startupBrandSequence.css）。 */
export const STARTUP_BRAND_FACES = ["😋", "😜", "🤪", "😋"] as const;

/**
 * 单帧停留时长：四帧一轮 900ms，必须与 startupBrandSequence.css 的动画周期一致。
 * 第 i 帧的动画延迟是 `i * 本值`（正延迟），帧序与 STARTUP_BRAND_FACES 的书写顺序一致。
 */
export const STARTUP_BRAND_FACE_FRAME_MS = 225;

/**
 * 阶段 2 的图标弹出时长，必须与 startupBrandSequence.css 的 badge-pop 时长一致；
 * 启动屏的退出保持期也取这个值，保证动画播完才卸载。
 */
export const STARTUP_BRAND_SETTLE_MS = 420;
