/**
 * 大文本只读预览的稀疏行索引。
 *
 * 预览正文本身已经是内存里的完整字符串；`code.split("\n")` 会再生成一份与
 * 行数同量级的字符串数组，而每行一个 `Uint32Array` 偏移在最坏情况（大量空行）
 * 下也要约 4 字节 / 行。虚拟视图每次只需要可视的十几到几十行，因此这里用
 * **两级索引**：
 *
 * - **checkpoint 层**：每隔 `PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL`（256）行
 *   记录一次行首的 UTF-16 偏移，常驻内存只有 `ceil(行数 / 256) * 4` 字节；
 * - **窗口层**：查询某行时，从它所属区间最近的 checkpoint 起向前扫描，最多走
 *   255 个换行就到达目标行首，再向后找到该行结束的换行。扫描量以 checkpoint
 *   间隔和该行长度为上界，不会退化成每次查询都扫全文。
 *
 * 语义必须与 `split("\n")` 完全一致：
 * - `""` 是 1 行空串；
 * - 每个 `\n` 结束一行，行内保留 `\r`（CRLF 的 `\r` 属于该行内容）；
 * - 结尾是 `\n` 时再多一个空末行。
 */
export interface PreviewTextLineIndex {
  /** 行数，等价于 `code.split("\n").length`。 */
  readonly lineCount: number;
  /** checkpoint 数量；常驻内存为 `checkpointCount * 4` 字节。 */
  readonly checkpointCount: number;
  /** 取第 index 行的内容；越界返回空串。 */
  lineAt(index: number): string;
}

/** checkpoint 间隔：每 256 行记录一次行首偏移。 */
export const PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL = 256;

/**
 * 空正文也要有 1 行，保证虚拟器 count 不出现 0。
 * 偏移用 Uint32Array：单字符串长度在 V8 上不超过 2^29-24，一定放得下。
 */
export function buildPreviewTextLineIndex(code: string): PreviewTextLineIndex {
  let lineCount = 1;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }

  // checkpoints[i] 是第 i * interval 行的行首偏移；[0] 恒为 0。
  const checkpointCount = Math.ceil(lineCount / PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL);
  const checkpoints = new Uint32Array(checkpointCount);
  let line = 0;
  let nextCheckpoint = 1;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) !== 10) {
      continue;
    }
    line += 1;
    if (line % PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL === 0 && nextCheckpoint < checkpointCount) {
      checkpoints[nextCheckpoint] = index + 1;
      nextCheckpoint += 1;
    }
  }

  return {
    lineCount,
    checkpointCount,
    lineAt(index: number): string {
      if (!Number.isInteger(index) || index < 0 || index >= lineCount) {
        return "";
      }
      const checkpointIndex = Math.floor(index / PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL);
      let start = checkpoints[checkpointIndex]!;
      let cursorLine = checkpointIndex * PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL;
      // 从 checkpoint 前进到目标行首：最多 interval - 1 个换行。
      while (cursorLine < index) {
        const newline = code.indexOf("\n", start);
        start = newline + 1;
        cursorLine += 1;
      }
      // 行结束位置：本行后的第一个换行，没有则为正文末尾。空行 start === end。
      let end = code.indexOf("\n", start);
      if (end === -1) {
        end = code.length;
      }
      return start >= end ? "" : code.slice(start, end);
    },
  };
}
