import type { FileTextWindow } from "@zcode/shared";
import {
  FILES_TEXT_WINDOW_READ_BUDGET_FACTOR,
  FILES_TEXT_WINDOW_READ_BUDGET_SLACK,
  FILES_TEXT_WINDOW_READ_CONCURRENCY,
  FILES_TEXT_WINDOW_STEP_BYTES,
} from "@/files-workbench/filesTextReadLimits.js";
import {
  FilesTextReadAbortedError,
  FilesTextReadChangedError,
  isFilesTextReadMissingError,
  largeTextRead,
  textWindowLength,
  type FilesEditableTextRead,
  type FilesLargeTextRead,
  type FilesTextReadCancelCheck,
  type FilesTextWindowReader,
} from "@/files-workbench/filesTextReadTypes.js";

/**
 * 有界并发的 256 KiB 窗口流水线。
 *
 * 首窗内容直接作为第 0 段，不重读。后续窗口按名义步长并发发出（最多
 * `FILES_TEXT_WINDOW_READ_CONCURRENCY` 个在途），但提交顺序固定按计划序号：
 * 每个窗口只把「已确认连续前沿之后」的原始字节追加进正文，因此并发只减少
 * 往返次数，不改变正文的字节顺序，也不会重复。
 *
 * 不变量：
 * - 首窗 `version` / `totalBytes` 是全链唯一权威，任一窗口不匹配立即整次失败；
 * - `coveredEnd` 永远是已提交正文的真实 UTF-8 字节终点，正文长度 = `coveredEnd`；
 * - 每次请求都必须相对自己的 `requestedOffset` 前进（EOF 除外），否则立即失败，
 *   不在同一前沿原地重试；
 * - 名义窗口重叠 8 字节，服务最多再向前回退 3 字节，所以实际窗口必然覆盖到
 *   上一窗口终点之后，不会出现无主空洞；
 * - 结果消费始终有界：在途 + 待提交窗口数 ≤ 并发上限，不累积整份 Promise 列表；
 * - 取消只停本端调度，在途请求自然完成并丢弃，不跨 RPC 发取消。
 */

/** UTF-8 码点编码后的字节数。 */
function utf8CodePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * 裁掉已覆盖字符的 UTF-8 字节前缀。
 *
 * 已提交前沿与窗口原始起点都是字节坐标；合法 UTF-8 下两者都是码点边界，
 * 所以按码点累计字节数即可精确切分，不需要重新编码整窗字符串。
 * 落不到码点边界说明窗口边界不可信，返回 undefined 由调用方判失败。
 */
export function trimUtf8PrefixBytes(content: string, bytes: number): string | undefined {
  if (bytes <= 0) {
    return content;
  }
  let seen = 0;
  let index = 0;
  while (index < content.length && seen < bytes) {
    const codePoint = content.codePointAt(index);
    if (codePoint === undefined) {
      return undefined;
    }
    seen += utf8CodePointBytes(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return seen === bytes ? content.slice(index) : undefined;
}

/**
 * 首窗自身的区间校验。
 *
 * `bytesRead` 必须等于 `nextOffset - offset`，否则后续按字节范围裁剪的重叠前缀
 * 会把错位内容当成正文提交；首窗也不例外。
 */
export function assertFirstTextWindow(firstWindow: FileTextWindow, path: string): void {
  if (firstWindow.offset !== 0) {
    throw new FilesTextReadChangedError(
      `First text window did not start at offset 0: ${path} (${firstWindow.offset})`,
    );
  }
  if (firstWindow.bytesRead !== firstWindow.nextOffset - firstWindow.offset) {
    throw new FilesTextReadChangedError(
      `First text window byte range is inconsistent: ${path} (${firstWindow.offset} -> ${firstWindow.nextOffset}, bytesRead=${firstWindow.bytesRead})`,
    );
  }
  const expectedEof = firstWindow.nextOffset === firstWindow.totalBytes;
  if (
    firstWindow.nextOffset < 0 ||
    firstWindow.nextOffset > firstWindow.totalBytes ||
    firstWindow.eof !== expectedEof ||
    (firstWindow.nextOffset === 0 && firstWindow.totalBytes > 0)
  ) {
    throw new FilesTextReadChangedError(
      `First text window ended inconsistently: ${path} (${firstWindow.nextOffset}/${firstWindow.totalBytes}, eof=${firstWindow.eof})`,
    );
  }
}

type TextWindowOutcome =
  | { index: number; start: number; ok: true; window: FileTextWindow }
  | { index: number; start: number; ok: false; error: unknown };

interface PendingTextWindow {
  index: number;
  start: number;
  outcome: Promise<TextWindowOutcome>;
}

type WindowMergeResult = "ok" | "no-progress" | "large-text";

/** 从首窗继续读到 EOF，每窗不超过 `FILE_TEXT_WINDOW_MAX_BYTES`。 */
export async function readEditableWindows(
  reader: FilesTextWindowReader,
  path: string,
  firstWindow: FileTextWindow,
  options?: { signal?: AbortSignal; isCancelled?: FilesTextReadCancelCheck },
): Promise<FilesEditableTextRead | FilesLargeTextRead> {
  const totalBytes = firstWindow.totalBytes;
  const version = firstWindow.version;
  assertFirstTextWindow(firstWindow, path);

  const throwIfCancelled = (): void => {
    if (options?.signal?.aborted === true || options?.isCancelled?.() === true) {
      throw new FilesTextReadAbortedError(`Text read aborted: ${path}`);
    }
  };

  let coveredEnd = firstWindow.nextOffset;
  const parts: string[] = [firstWindow.content];
  let planCursor = coveredEnd;
  let nextIndex = 0;
  let commitIndex = 0;
  let requests = 0;
  // 预算只防御退化的极短窗口服务：正常路径一次请求覆盖一个步长，短读时同一段
  // 多次补读。按「名义窗口数 × 常数」而不是「totalBytes / 4」计算，请求总数
  // 始终与文件大小同阶（248 MiB 约 8 千次上界），不会放大到上亿次；超出预算
  // 按明确错误失败，不做无界重试。
  const nominalWindows = Math.max(1, Math.ceil(totalBytes / FILES_TEXT_WINDOW_STEP_BYTES));
  const requestBudget =
    nominalWindows * FILES_TEXT_WINDOW_READ_BUDGET_FACTOR + FILES_TEXT_WINDOW_READ_BUDGET_SLACK;
  const inFlight: PendingTextWindow[] = [];
  const buffered = new Map<number, FileTextWindow>();

  const spendBudget = (offset: number): void => {
    requests += 1;
    if (requests > requestBudget) {
      throw new FilesTextReadChangedError(
        `Text window request budget exceeded: ${path} (${offset})`,
      );
    }
  };

  const assertConsistent = (window: FileTextWindow, requestedStart: number): void => {
    if (window.version !== version || window.totalBytes !== totalBytes || window.isBinary) {
      throw new FilesTextReadChangedError(
        `File changed while reading complete text: ${path} (${requestedStart})`,
      );
    }
    // 服务只把起点向前对齐到码点起始，最多 3 字节；更大的回退不可信。
    if (window.offset > requestedStart || window.offset < Math.max(0, requestedStart - 3)) {
      throw new FilesTextReadChangedError(
        `Text window returned unexpected offset: ${path} (${requestedStart} -> ${window.offset})`,
      );
    }
    // 每个请求必须相对自己的起点真正前进。否则调度会以为已完成，随后反复请求
    // 同一前沿，直到耗尽预算（退化服务会让读取空转数十万次）。
    if (window.nextOffset <= requestedStart && window.eof !== true) {
      throw new FilesTextReadChangedError(
        `Text window did not advance: ${path} (${requestedStart} -> ${window.nextOffset})`,
      );
    }
    if (
      window.nextOffset <= window.offset ||
      window.nextOffset > totalBytes ||
      window.eof !== (window.nextOffset === totalBytes)
    ) {
      throw new FilesTextReadChangedError(
        `Text window ended inconsistently: ${path} (${window.offset} -> ${window.nextOffset}, eof=${window.eof})`,
      );
    }
    // 归并按 `nextOffset - offset` 当作窗口真实字节长度，因此它必须与 bytesRead
    // 一致；否则裁剪会把错位内容当成正文提交。
    if (window.bytesRead !== window.nextOffset - window.offset) {
      throw new FilesTextReadChangedError(
        `Text window byte range is inconsistent: ${path} (${window.offset} -> ${window.nextOffset}, bytesRead=${window.bytesRead})`,
      );
    }
  };

  const appendWindow = (window: FileTextWindow): WindowMergeResult => {
    if (window.hasDecodingErrors === true) {
      // 任一窗口含非法 UTF-8：此前读到的正文也不能作为可编辑全文提交。
      // 只保留首窗前缀给固定块模型，失败窗口及其后的正文不进入缓冲。
      return "large-text";
    }
    if (window.nextOffset <= coveredEnd) {
      return "no-progress";
    }
    // 名义窗口之间重叠 8 字节，服务还可能把起点回退最多 3 字节；因此已覆盖的
    // 字节前缀必须按原始字节范围裁掉，不能按到达顺序直接拼接。
    const trimBytes = coveredEnd - window.offset;
    const content =
      trimBytes <= 0 ? window.content : trimUtf8PrefixBytes(window.content, trimBytes);
    if (content === undefined) {
      throw new FilesTextReadChangedError(
        `Text window boundary is not a code point boundary: ${path} (${window.offset}/${coveredEnd})`,
      );
    }
    parts.push(content);
    coveredEnd = window.nextOffset;
    return "ok";
  };

  const finishLargeText = (): FilesLargeTextRead => largeTextRead(firstWindow, "encoding");

  /**
   * 在途 / 待提交窗口按服务契约能到达的最远字节。
   *
   * 每个请求最多返回一个整窗；只要这个链条越过已确认前沿，就不需要额外补读，
   * 补读只会重复拉同一段远端数据。判断只读本地计划状态，不依赖超时。
   */
  const outstandingReach = (): number => {
    let reach = coveredEnd;
    for (const entry of inFlight) {
      reach = Math.max(reach, entry.start + textWindowLength());
    }
    for (const window of buffered.values()) {
      reach = Math.max(reach, window.offset + textWindowLength());
    }
    return reach;
  };

  const readOne = async (offset: number): Promise<FileTextWindow> => {
    throwIfCancelled();
    spendBudget(offset);
    let window: FileTextWindow;
    try {
      window = await reader.readTextFileWindow({
        path,
        offset,
        length: textWindowLength(),
        expectedVersion: version,
      });
    } catch (error) {
      // 首窗成功后才进入这里：后续窗口的 ENOENT 说明文件在完整读取期间被删除
      // 或替换，不能按「保存时目标不存在」重建文件，必须按版本变化整体失败。
      if (isFilesTextReadMissingError(error)) {
        throw new FilesTextReadChangedError(
          `File disappeared while reading complete text: ${path} (${offset})`,
        );
      }
      throw error;
    }
    assertConsistent(window, offset);
    return window;
  };

  // 服务短读或非精确步进会留下空洞；按已确认边界补读，直到越过当前窗口起点。
  // 补读同样受请求预算约束，并由 `assertConsistent` 的前进检查保证不会原地打转。
  // 返回值已排除 `no-progress`：完全被覆盖的窗口视为成功（异步提交幂等）。
  const commitWindow = async (
    window: FileTextWindow,
  ): Promise<Exclude<WindowMergeResult, "no-progress">> => {
    while (window.offset > coveredEnd) {
      const fill = await readOne(coveredEnd);
      const result = appendWindow(fill);
      if (result === "no-progress") {
        throw new FilesTextReadChangedError(
          `Text window made no progress: ${path} (${coveredEnd})`,
        );
      }
      if (result !== "ok") {
        return result;
      }
    }
    const result = appendWindow(window);
    return result === "no-progress" ? "ok" : result;
  };

  try {
    throwIfCancelled();
    while (coveredEnd < totalBytes) {
      while (
        inFlight.length + buffered.size < FILES_TEXT_WINDOW_READ_CONCURRENCY &&
        coveredEnd < totalBytes
      ) {
        throwIfCancelled();
        // 计划游标负责“往前铺”，实际起点不落后于已确认前沿，避免重读已覆盖字节。
        // 走到文件尾附近时改回以已确认前沿为起点（短读 / 尾部），并且只在没有任何
        // 在途窗口覆盖这段前沿时才补读，避免重复拉同一段远端数据。
        const plannedStart = planCursor;
        let start: number;
        if (plannedStart < totalBytes) {
          start = Math.max(plannedStart, coveredEnd);
          planCursor += FILES_TEXT_WINDOW_STEP_BYTES;
        } else {
          if (outstandingReach() > coveredEnd) {
            break;
          }
          start = coveredEnd;
          planCursor = coveredEnd + FILES_TEXT_WINDOW_STEP_BYTES;
        }
        if (start >= totalBytes || inFlight.some((entry) => entry.start === start)) {
          break;
        }
        const index = nextIndex;
        nextIndex += 1;
        spendBudget(start);
        inFlight.push({
          index,
          start,
          outcome: reader
            .readTextFileWindow({
              path,
              offset: start,
              length: textWindowLength(),
              expectedVersion: version,
            })
            .then(
              (window) => ({ index, start, ok: true as const, window }),
              (error) => ({ index, start, ok: false as const, error }),
            ),
        });
      }

      // 只按计划序号提交，保证「乱序完成」不会把后段正文提前写进缓冲。
      let progressed = false;
      for (;;) {
        const window = buffered.get(commitIndex);
        if (window === undefined) {
          break;
        }
        buffered.delete(commitIndex);
        commitIndex += 1;
        const before = coveredEnd;
        const result = await commitWindow(window);
        if (result !== "ok") {
          return finishLargeText();
        }
        if (coveredEnd > before) {
          progressed = true;
        }
        if (coveredEnd >= totalBytes) {
          break;
        }
      }
      if (coveredEnd >= totalBytes) {
        break;
      }
      if (progressed) {
        continue;
      }

      if (inFlight.length === 0) {
        throw new FilesTextReadChangedError(
          `Text window did not reach EOF: ${path} (${coveredEnd})`,
        );
      }
      const outcome = await Promise.race(inFlight.map((entry) => entry.outcome));
      const position = inFlight.findIndex((entry) => entry.index === outcome.index);
      if (position >= 0) {
        inFlight.splice(position, 1);
      }
      if (!outcome.ok) {
        if (isFilesTextReadMissingError(outcome.error)) {
          throw new FilesTextReadChangedError(
            `File disappeared while reading complete text: ${path} (${outcome.start})`,
          );
        }
        throw outcome.error;
      }
      assertConsistent(outcome.window, outcome.start);
      buffered.set(outcome.index, outcome.window);
    }
  } finally {
    // 提前返回（large-text / too-large / 取消 / 失败）时，未消费的在途请求已经用
    // `.then` 收敛成 outcome，不会变成 unhandled rejection；这里只释放引用。
    inFlight.length = 0;
    buffered.clear();
  }

  // 读完最后一段后也要尊重取消：否则恰好在取消瞬间完成的读取会把结果送回去，
  // 虽然调用方还会按 disposed 丢弃，但语义上应当直接作废。
  throwIfCancelled();

  if (coveredEnd !== totalBytes) {
    throw new FilesTextReadChangedError(
      `Text window ended before totalBytes: ${path} (${coveredEnd}/${totalBytes})`,
    );
  }

  return {
    mode: "editable",
    text: parts.join(""),
    totalBytes,
    version,
  };
}
