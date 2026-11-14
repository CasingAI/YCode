/** 夹具与浏览器共用的路径 / 目标文件常量。 */

export const E2E_PATH = "/workspace/e2e/e2e-large.json";
/** 50 MiB 多行文件：验证大批量键盘输入的逐键路径与保存快照。 */
export const E2E_LARGE_PATH = "/workspace/e2e/e2e-large-50mib.json";
/** 10 MiB 单行文件：验证有界首行读取与超长单行输入路径。 */
export const E2E_SINGLE_LINE_PATH = "/workspace/e2e/e2e-single-line.json";

/**
 * 用户报告的真实文件大小 10174816 字节（约 9.7 MiB）。
 *
 * 行数取 395602（约 40 万行）：`{"id":i,"value":""}` 这一自然 JSON 结构在
 * 该行数下刚好略小于目标字节数，尾部再补少量字符即可精确命中 10174816，
 * 不需要为了凑字节改变每行的 JSON 形状。
 */
export const TARGET_BYTES = 10_174_816;
export const TARGET_LINES = 395_602;

/** 50 MiB 多行目标体积（二进制 MiB，与磁盘字节一致）。 */
export const LARGE_TARGET_BYTES = 50 * 1024 * 1024;
/** 10 MiB 单行目标体积。 */
export const SINGLE_LINE_TARGET_BYTES = 10 * 1024 * 1024;

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
  /** 50 MiB 文件的尾部 marker。 */
  largeTail: "ZCODE_LARGE_50MIB_TAIL_TOKEN",
  /** 50 MiB 文件在 8 MiB 之后的唯一 token。 */
  largePastEightMiB: "ZCODE_LARGE_50MIB_PAST_EIGHT_MIB",
  /** 10 MiB 单行文件开头的 marker。 */
  singleLineHead: "ZCODE_SINGLE_LINE_HEAD_10MIB",
  /** 10 MiB 单行文件末尾的 marker。 */
  singleLineTail: "ZCODE_SINGLE_LINE_TAIL_10MIB",
  /** 逐键性能场景输入的一批字符（不含引号 / 括号，避免自动闭合干扰计数）。 */
  perfTyped: "ZCODE_PERF_TYPED_ABCDEFGH",
  /** 保存 await 期间继续输入的第二批字符。 */
  saveDuringTyping: "ZCODE_DURING_SAVE_IJKL",
  /** 分屏 B 视图输入：两个 view 共享同一 model，监听应去重。 */
  splitSharedTyped: "ZCODE_SPLIT_B_ABCDEFGH",
  /** 关闭 B 后，存活 A 视图继续输入。 */
  splitSurvivorTyped: "ZCODE_SPLIT_C_IJKL",
  /** 同一 model 重建后的未保存输入，用于撤销回保存点。 */
  splitRebuildTyped: "ZCODE_REBUILD_MNOPQR",
};
