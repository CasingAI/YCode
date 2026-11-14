import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import test from "node:test";
import {
  FILE_TEXT_WINDOW_CHANGED_CODE,
  FILE_TEXT_WINDOW_MAX_BYTES,
  type FileTextWindow,
} from "@zcode/shared";
import {
  FILES_FULL_TEXT_MAX_BYTES,
  FILES_TEXT_WINDOW_READ_BUDGET_FACTOR,
  FILES_TEXT_WINDOW_READ_BUDGET_SLACK,
  FILES_TEXT_WINDOW_READ_CONCURRENCY,
  FilesTextReadChangedError,
  isFilesTextReadAbortedError,
  readFilesTextForOpen,
  readFilesTextForSave,
  resolveFilesTextReadMode,
} from "../src/files-workbench/filesEditorTextReader.js";

/**
 * 有界并发窗口流水线的边界测试。
 *
 * 窗口读取用真实 UTF-8 字节模拟 `@zcode/services` 的语义：起点/终点只向合法
 * 码点起始回退，绝不编造偏移。这样 2/3/4 字节字符正好跨在名义窗口边界时，
 * 并发归并仍必须还原逐字节一致的正文。
 */

interface WindowRequest {
  path: string;
  offset?: number;
  length?: number;
  expectedVersion?: string;
}

interface ReaderOptions {
  totalBytes?: number;
  version?: string;
  /** 每次请求的版本；用于模拟读盘期间文件被替换。 */
  versionFor?: (request: WindowRequest) => string;
  /** 限制单窗实际返回字节数，模拟短读。 */
  maxBytesPerRead?: number;
  /** 在返回前等待；用于制造乱序完成。 */
  delayFor?: (request: WindowRequest) => Promise<void>;
  /** 指定 offset 的窗口注入错误。 */
  errorFor?: (request: WindowRequest) => unknown;
  /** 完全替换窗口结果，用于模拟退化服务（例如返回不前进的窗口）。 */
  overrideFor?: (request: WindowRequest) => FileTextWindow | undefined;
  decodingErrorsFor?: (request: WindowRequest) => boolean;
}

const UTF8_MAX_BYTES = 4;

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function sequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** 与服务一致的合法码点起点回退；位于非法 continuation 串中返回 undefined。 */
function findCodePointStart(bytes: Buffer, index: number): number | undefined {
  const byte = index >= 0 && index < bytes.length ? bytes[index] : undefined;
  if (byte === undefined || !isContinuation(byte)) {
    return undefined;
  }
  for (
    let leadIndex = index - 1;
    leadIndex >= Math.max(0, index - (UTF8_MAX_BYTES - 1));
    leadIndex--
  ) {
    const lead = bytes[leadIndex];
    if (lead === undefined || isContinuation(lead)) continue;
    const length = sequenceLength(lead);
    if (length === 0) return undefined;
    const end = leadIndex + length;
    if (end <= index || end > bytes.length) return undefined;
    return isUtf8(bytes.subarray(leadIndex, end)) ? leadIndex : undefined;
  }
  return undefined;
}

function alignStart(bytes: Buffer, offset: number): number {
  if (offset <= 0) return 0;
  const leadIndex = findCodePointStart(bytes, Math.min(offset, bytes.length));
  return leadIndex === undefined ? offset : leadIndex;
}

function alignEnd(bytes: Buffer, alignedStart: number, relativeEnd: number): number {
  const desiredEnd = alignedStart + relativeEnd;
  if (desiredEnd >= bytes.length) return bytes.length;
  const leadIndex = findCodePointStart(bytes, desiredEnd);
  return leadIndex === undefined ? desiredEnd : leadIndex;
}

function createReader(content: Buffer, options?: ReaderOptions) {
  const calls: WindowRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const reader = {
    calls,
    maxInFlight: () => maxInFlight,
    async readTextFileWindow(request: WindowRequest): Promise<FileTextWindow> {
      calls.push(request);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const delay = options?.delayFor?.(request);
        if (delay) {
          await delay;
        }
        const injected = options?.errorFor?.(request);
        if (injected !== undefined) {
          throw injected;
        }
        const overridden = options?.overrideFor?.(request);
        if (overridden !== undefined) {
          return overridden;
        }
        const version = options?.versionFor?.(request) ?? options?.version ?? "v1";
        const totalBytes = options?.totalBytes ?? content.length;
        const isBinary = false;
        const requestedOffset = request.offset ?? 0;
        if (requestedOffset >= totalBytes) {
          return {
            path: request.path,
            content: "",
            offset: totalBytes,
            bytesRead: 0,
            nextOffset: totalBytes,
            totalBytes,
            version,
            isBinary,
            eof: true,
            hasDecodingErrors: false,
            truncated: false,
          };
        }
        const maxRead = Math.min(
          request.length ?? FILE_TEXT_WINDOW_MAX_BYTES,
          FILE_TEXT_WINDOW_MAX_BYTES,
        );
        const alignedStart = alignStart(content, requestedOffset);
        const desiredEnd = Math.min(totalBytes, alignedStart + maxRead);
        const cap = options?.maxBytesPerRead;
        const cappedEnd = cap === undefined ? desiredEnd : Math.min(desiredEnd, alignedStart + cap);
        const end = Math.min(
          alignEnd(content, alignedStart, cappedEnd - alignedStart),
          content.length,
        );
        const eof = end >= totalBytes;
        return {
          path: request.path,
          content: content.subarray(alignedStart, end).toString("utf8"),
          offset: alignedStart,
          bytesRead: end - alignedStart,
          nextOffset: end,
          totalBytes,
          version,
          isBinary,
          eof,
          hasDecodingErrors: options?.decodingErrorsFor?.(request) === true,
          truncated: !eof,
        };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return reader;
}

/** 让 2/3/4 字节码点反复出现在任意名义边界附近。 */
function mixedWidthText(repeats: number): string {
  return "a😀中é\r\n".repeat(repeats);
}

test("2/3/4 字节字符跨窗口边界时仍得到逐字符一致的完整正文", async () => {
  const text = mixedWidthText(90_000);
  const bytes = Buffer.from(text, "utf8");
  assert.ok(bytes.length > 4 * FILE_TEXT_WINDOW_MAX_BYTES);
  const reader = createReader(bytes);

  const result = await readFilesTextForOpen(reader, "/work/mixed.txt");

  assert.equal(result.mode, "editable");
  assert.equal(result.mode === "editable" ? result.text : "", text);
  // 首窗只读一次，所有后续请求都带首窗版本。
  assert.equal(reader.calls.filter((call) => (call.offset ?? 0) === 0).length, 1);
  for (const call of reader.calls.slice(1)) {
    assert.equal(call.expectedVersion, "v1");
  }
});

test("乱序完成不改变正文顺序，且在途请求不超过上限", async () => {
  const text = "0123456789abcdef".repeat(40_000);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes, {
    // 越靠后的窗口先返回，强制提交顺序与完成顺序分离。
    delayFor: async (request) => {
      const offset = request.offset ?? 0;
      const steps = Math.max(0, 8 - Math.floor(offset / FILE_TEXT_WINDOW_MAX_BYTES));
      for (let i = 0; i < steps; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  });

  const result = await readFilesTextForOpen(reader, "/work/out-of-order.txt");

  assert.equal(result.mode, "editable");
  assert.equal(result.mode === "editable" ? result.text : "", text);
  assert.ok(reader.maxInFlight() <= FILES_TEXT_WINDOW_READ_CONCURRENCY);
  assert.ok(reader.maxInFlight() > 1, "应真的并发读窗");
});

test("每窗只返回 1000 字节的短读也不会留下空洞或重复", async () => {
  const text = mixedWidthText(4_000);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes, { maxBytesPerRead: 1_000 });

  const result = await readFilesTextForOpen(reader, "/work/short-read.txt");

  assert.equal(result.mode, "editable");
  assert.equal(result.mode === "editable" ? result.text : "", text);
  assert.ok(reader.maxInFlight() <= FILES_TEXT_WINDOW_READ_CONCURRENCY);
});

test("CRLF 与 BOM 原样保留，空文件与纯换行文件也正确", async () => {
  const withBom = "\ufeffa\r\nb\r\n";
  const bomReader = createReader(Buffer.from(withBom, "utf8"));
  const bomResult = await readFilesTextForOpen(bomReader, "/work/bom.txt");
  assert.equal(bomResult.mode, "editable");
  assert.equal(bomResult.mode === "editable" ? bomResult.text : "", withBom);

  const emptyResult = await readFilesTextForOpen(createReader(Buffer.alloc(0)), "/work/empty.txt");
  assert.equal(emptyResult.mode, "editable");
  assert.equal(emptyResult.mode === "editable" ? emptyResult.text : "x", "");

  const newlines = "\n\n\n";
  const newlineResult = await readFilesTextForOpen(
    createReader(Buffer.from(newlines, "utf8")),
    "/work/newlines.txt",
  );
  assert.equal(newlineResult.mode === "editable" ? newlineResult.text : "x", newlines);
});

test("后续窗口 ENOENT 或版本变化都整次失败，打开与保存一致", async () => {
  const text = "V".repeat(FILE_TEXT_WINDOW_MAX_BYTES + 10);
  const bytes = Buffer.from(text, "utf8");
  const missingOnSecond = createReader(bytes, {
    errorFor: (request) =>
      (request.offset ?? 0) > 0
        ? Object.assign(new Error("missing"), { code: "ENOENT" })
        : undefined,
  });
  const versionChange = createReader(bytes, {
    versionFor: (request) => ((request.offset ?? 0) > 0 ? "v2" : "v1"),
  });
  const isChanged = (error: unknown) =>
    error instanceof FilesTextReadChangedError &&
    (error as { code?: string }).code === FILE_TEXT_WINDOW_CHANGED_CODE;

  await assert.rejects(() => readFilesTextForOpen(missingOnSecond, "/work/a.txt"), isChanged);
  await assert.rejects(() => readFilesTextForSave(missingOnSecond, "/work/a.txt"), isChanged);
  await assert.rejects(() => readFilesTextForOpen(versionChange, "/work/b.txt"), isChanged);
  await assert.rejects(() => readFilesTextForSave(versionChange, "/work/b.txt"), isChanged);
});

test("后续窗口出现解码错误时丢弃正文并只保留首窗种子", async () => {
  const text = "A".repeat(4 * FILE_TEXT_WINDOW_MAX_BYTES);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes, {
    decodingErrorsFor: (request) => (request.offset ?? 0) > 0,
  });

  const result = await readFilesTextForOpen(reader, "/work/lossy-later.txt");

  assert.equal(result.mode, "large-text");
  assert.ok(result.mode === "large-text");
  assert.equal(result.reason, "encoding");
  assert.equal(result.firstWindow.offset, 0);
  assert.equal(result.firstWindow.content, "A".repeat(FILE_TEXT_WINDOW_MAX_BYTES));
  assert.equal("text" in result, false);
  // 解码错误一旦出现即停止提交，不再请求后续窗口。
  assert.ok(reader.calls.length <= FILES_TEXT_WINDOW_READ_CONCURRENCY + 1);
});

test("超过字节上限的文件只做一次决策读取就判 too-large", async () => {
  const totalBytes = FILES_FULL_TEXT_MAX_BYTES + 1;
  const reader = createReader(Buffer.from("head", "utf8"), { totalBytes });

  const result = await readFilesTextForOpen(reader, "/work/huge-ascii.txt");

  assert.equal(result.mode, "too-large");
  assert.equal(result.totalBytes, totalBytes);
  assert.equal("text" in result, false);
  assert.equal(reader.calls.length, 1);

  assert.equal(
    resolveFilesTextReadMode({
      isBinary: false,
      totalBytes: FILES_FULL_TEXT_MAX_BYTES,
    }),
    "editable",
  );
  assert.equal(
    resolveFilesTextReadMode({
      isBinary: false,
      totalBytes: FILES_FULL_TEXT_MAX_BYTES + 1,
    }),
    "too-large",
  );
});

test("窗口 bytesRead 与 offset/nextOffset 不一致时整次失败，不按错位区间裁剪", async () => {
  const text = "A".repeat(FILE_TEXT_WINDOW_MAX_BYTES + 100);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes);
  const original = reader.readTextFileWindow.bind(reader);
  reader.readTextFileWindow = async (request) => {
    const window = await original(request);
    return (request.offset ?? 0) > 0 ? { ...window, bytesRead: window.bytesRead + 7 } : window;
  };

  await assert.rejects(
    () => readFilesTextForOpen(reader, "/work/bytes-read.txt"),
    /byte range is inconsistent/,
  );
});

test("请求数上界随窗口数线性增长，不与短读次数相乘", async () => {
  const text = "x".repeat(6 * FILE_TEXT_WINDOW_MAX_BYTES);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes);
  const totalBytes = bytes.length;

  await readFilesTextForOpen(reader, "/work/bounded.txt");

  const windows = Math.ceil(totalBytes / FILE_TEXT_WINDOW_MAX_BYTES);
  assert.ok(reader.calls.length <= FILES_TEXT_WINDOW_READ_BUDGET_FACTOR * windows + 64);
  assert.ok(reader.calls.length >= windows);
});

test("退化服务在同一请求起点返回不前进的窗口时立即失败，不原地重试耗尽预算", async () => {
  // 复现 reviewer 的例子：total=100，首窗 [0,10)；后续任何请求都返回
  // offset 7 / bytesRead 3 / nextOffset 10（自洽但相对 requestedOffset 不前进）。
  const totalBytes = 100;
  const firstWindow: FileTextWindow = {
    path: "/work/degenerate.txt",
    content: "a".repeat(10),
    offset: 0,
    bytesRead: 10,
    nextOffset: 10,
    totalBytes,
    version: "v1",
    isBinary: false,
    eof: false,
    hasDecodingErrors: false,
  };
  const staleWindow: FileTextWindow = {
    ...firstWindow,
    content: "bbb",
    offset: 7,
    bytesRead: 3,
    nextOffset: 10,
  };
  const reader = createReader(Buffer.from("a".repeat(totalBytes), "utf8"), {
    totalBytes,
    overrideFor: (request) => ((request.offset ?? 0) > 0 ? staleWindow : firstWindow),
  });

  const started = reader.calls.length;
  await assert.rejects(
    () => readFilesTextForOpen(reader, "/work/degenerate.txt"),
    /did not advance/,
  );
  // 首次异常即停止：首窗 + 至多并发上限的启动请求，不会跑满预算。
  assert.ok(
    reader.calls.length - started <= FILES_TEXT_WINDOW_READ_CONCURRENCY + 1,
    `首次无进展后不应继续拉新请求: ${reader.calls.length - started}`,
  );
});

test("合法但极短（每窗 1 字节）的服务会受控失败，而不是无界重试", async () => {
  // 1 字节窗口不违反 length>=4 契约（服务可能因回退返回更短），但会让请求数
  // 随字节数放大。这里断言读到预算上限即明确失败，并且请求数有界。
  const text = "y".repeat(64 * 1024);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes, { maxBytesPerRead: 1 });

  await assert.rejects(
    () => readFilesTextForOpen(reader, "/work/tiny-windows.txt"),
    /request budget exceeded/,
  );
  const windows = Math.ceil(bytes.length / (FILE_TEXT_WINDOW_MAX_BYTES - 8));
  const budget =
    Math.max(1, windows) * FILES_TEXT_WINDOW_READ_BUDGET_FACTOR +
    FILES_TEXT_WINDOW_READ_BUDGET_SLACK;
  // 预算在「第 budget+1 次」请求时抛错，因此实际发起数最多 budget+1。
  assert.ok(
    reader.calls.length <= budget + 1,
    `请求数应受预算约束: ${reader.calls.length} <= ${budget + 1}`,
  );
});

test("首窗 bytesRead 与 nextOffset-offset 不一致时整次失败", async () => {
  const text = "A".repeat(200);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes);
  const original = reader.readTextFileWindow.bind(reader);
  reader.readTextFileWindow = async (request) => {
    const window = await original(request);
    return (request.offset ?? 0) === 0 ? { ...window, bytesRead: window.bytesRead - 1 } : window;
  };

  await assert.rejects(
    () => readFilesTextForOpen(reader, "/work/first-bytes.txt"),
    /First text window byte range is inconsistent/,
  );
});

test("取消后停止调度后续窗口，在途请求不超过并发上限且不产生未处理 rejection", async () => {
  const text = "C".repeat(24 * FILE_TEXT_WINDOW_MAX_BYTES);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes, {
    delayFor: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  let cancelled = false;
  let callsAtCancel = 0;
  const controller = new AbortController();

  const pending = readFilesTextForOpen(reader, "/work/cancel.txt", {
    signal: controller.signal,
    isCancelled: () => cancelled,
  });
  // 等首批在途请求发出后再取消。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  cancelled = true;
  callsAtCancel = reader.calls.length;
  controller.abort();

  await assert.rejects(pending, (error) => isFilesTextReadAbortedError(error));
  // 取消后只允许已经在途的并发请求落地，不会继续按窗口数铺满。
  assert.ok(
    reader.calls.length - callsAtCancel <= FILES_TEXT_WINDOW_READ_CONCURRENCY,
    `取消后不应继续调度: 取消时 ${callsAtCancel} -> 结束 ${reader.calls.length}`,
  );
  assert.ok(reader.maxInFlight() <= FILES_TEXT_WINDOW_READ_CONCURRENCY);
  // 让所有迟到请求落地，验证没有 unhandled rejection。
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("取消不是「文件被修改」：aborted 错误不被 changed 判定捕获", async () => {
  const reader = createReader(Buffer.from("abc", "utf8"));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => readFilesTextForOpen(reader, "/work/pre-aborted.txt", { signal: controller.signal }),
    (error) => {
      assert.equal(isFilesTextReadAbortedError(error), true);
      assert.equal(error instanceof FilesTextReadChangedError, false);
      return true;
    },
  );
  // 已取消时连首窗都不发。
  assert.equal(reader.calls.length, 0);
});

test("所有后续窗口请求的起点单调递增且不重复读取已覆盖区间", async () => {
  const text = mixedWidthText(30_000);
  const bytes = Buffer.from(text, "utf8");
  const reader = createReader(bytes);

  await readFilesTextForOpen(reader, "/work/monotonic.txt");

  // 首窗之外的请求起点不倒退；同时允许尾部动态补读对同一可信边界重试一次
  //（服务短读时才知道那段没人覆盖），但绝不会越过已覆盖前沿去重读。
  const offsets = reader.calls.slice(1).map((call) => call.offset ?? 0);
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(
      offsets[index]! >= offsets[index - 1]!,
      `窗口起点不应倒退: ${offsets[index - 1]} -> ${offsets[index]}`,
    );
  }
  const uniqueStarts = new Set(offsets);
  assert.ok(
    uniqueStarts.size >= offsets.length - 2,
    `重复起点应只出现在尾部补读: ${offsets.length} 个请求 / ${uniqueStarts.size} 个起点`,
  );
  for (const call of reader.calls) {
    assert.ok((call.length ?? 0) <= FILE_TEXT_WINDOW_MAX_BYTES);
  }
});
