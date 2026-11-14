import { FILE_TEXT_WINDOW_MAX_BYTES } from "@zcode/shared";

/**
 * 文本完整读取与展示的受控上限。
 *
 * 这些常量描述「主动拒绝」与「异常服务保护」，不是性能保证：接近上限的文档
 * 依然可能卡顿。
 */

/**
 * 完整正文的保守字节上限：248 MiB。
 *
 * - 低于 V8 单字符串硬上限（约 512 MiB），构造正文本身不会因超长抛错；
 * - 低于 Monaco `TextModel.LARGE_FILE_HEAP_OPERATION_THRESHOLD`（256 Mi UTF-16
 *   code units 时 `getValue()` 会抛 `Operation would exceed heap memory limits`），
 *   并留出 8 MiB 编辑余量；
 * - UTF-8 字节数不小于其 UTF-16 code unit 数，因此按字节拒绝同时约束了编辑器
 *   能操作的字符数。
 *
 * 超过该字节数只表示「主动拒绝进入完整正文」，不代表字符数一定超限：以 3/4
 * 字节字符为主的大文件可能仍放得下。这是有意的保守取舍，避免先读满几百 MB
 * 才发现超限、峰值内存反而更大。
 */
export const FILES_FULL_TEXT_MAX_BYTES = 248 * 1024 * 1024;

/** 同时在途的 256 KiB 窗口请求上限；远程工作区靠它把串行往返压成流水线。 */
export const FILES_TEXT_WINDOW_READ_CONCURRENCY = 4;

/**
 * 名义窗口步长：比单窗上限少 8 字节。
 *
 * 服务对落在合法码点内部的 offset 最多回退 3 字节，窗口结束位置也最多回退
 * 3 字节，因此相邻名义窗口重叠 8 字节后，实际覆盖区间必然连续、不会出现空洞
 * （6 字节即可证明连续，8 字节是防御性余量）。多读的字节在归并时按实际字节
 * 范围裁掉，不会重复进入正文。
 */
export const FILES_TEXT_WINDOW_STEP_BYTES = FILE_TEXT_WINDOW_MAX_BYTES - 8;

/**
 * 每个名义窗口允许的请求倍数。
 *
 * 正常路径一次请求覆盖一个步长；短读时同一段需要多次补读。预算按
 * `名义窗口数 × 该倍数 + 固定余量` 计算，所以请求总数始终与文件大小同阶，
 * 不会因为「最小 4 字节窗口」放大到上亿次。超出预算按明确错误失败，不做
 * 无界重试；合法但极短的窗口服务因此会受控失败，而不是拖垮整个读取。
 */
export const FILES_TEXT_WINDOW_READ_BUDGET_FACTOR = 8;

/** 请求预算的固定余量：覆盖并发启动、尾部补读与起点最多 3 字节回退。 */
export const FILES_TEXT_WINDOW_READ_BUDGET_SLACK = 4 * FILES_TEXT_WINDOW_READ_CONCURRENCY + 64;
