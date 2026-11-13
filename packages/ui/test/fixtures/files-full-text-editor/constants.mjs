/** 夹具与浏览器共用的路径 / 目标文件常量。 */

export const E2E_PATH = "/workspace/e2e/e2e-large.json";

/**
 * 用户报告的真实文件大小 10174816 字节（约 9.7 MiB）。
 *
 * 行数取 395602（约 40 万行）：`{"id":i,"value":""}` 这一自然 JSON 结构在
 * 该行数下刚好略小于目标字节数，尾部再补少量字符即可精确命中 10174816，
 * 不需要为了凑字节改变每行的 JSON 形状。
 */
export const TARGET_BYTES = 10_174_816;
export const TARGET_LINES = 395_602;

/** 旧实现的固定块步长与旧的「大文件」阈值；只用于说明夹具跨过这两条边界。 */
export const LEGACY_BLOCK_STEP = 262_140;
export const LEGACY_LARGE_FILE_BYTES = 8 * 1024 * 1024;

/** 真实标签保存按钮的无障碍名称（stub 的 zh-CN 文案）。 */
export const SAVE_BUTTON_LABEL = "保存";

export const TOKENS = {
  /** 起点在 262140 之前、终点跨过该偏移的唯一 token。 */
  boundaryLeft: "ZCODE_BOUNDARY_LEFT_262140",
  /** 起点正好在 262140 之后（含）的唯一 token。 */
  boundaryRight: "ZCODE_BOUNDARY_RIGHT_262140",
  /** 位于旧 8 MiB 阈值之后的唯一 token。 */
  pastEightMiB: "ZCODE_PAST_EIGHT_MIB_8388608",
  /** 文件尾部的唯一 marker。 */
  tail: "ZCODE_TAIL_END_TOKEN",
  /** 跨旧块编辑写入的合法 JSON 行。 */
  boundaryEdit: '{"id":999998,"value":"EDITED_ACROSS_262140_BOUNDARY"}',
  /** 未保存草稿写入的尾部行。 */
  draftTail: '{"id":399191,"value":"ZCODE_DRAFT_TAIL_TOKEN_RESTORED"}',
};
