import assert from "node:assert/strict";
import test from "node:test";
import { FILE_TEXT_WINDOW_MAX_BYTES, type FileTextWindow } from "@zcode/shared";
import {
  FILES_LARGE_TEXT_BLOCK_STEP,
  filesLargeTextBlockCount,
  filesLargeTextBlockIndex,
  filesLargeTextBlockReadRequest,
  filesLargeTextExactBlockReadRequest,
  filesLargeTextNominalBlockEnd,
  filesLargeTextNominalBlockStart,
  resolveFilesLargeTextAlignedBoundary,
  sliceFilesLargeTextBlockWindow,
} from "../src/files-workbench/filesLargeTextBlockModel.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** 模拟服务的 UTF-8 起点向更小字节偏移回退规则；非法时保留 requestedOffset。 */
function alignStart(bytes: Uint8Array, requested: number): number {
  const offset = Math.max(0, Math.min(requested, bytes.length));
  if (offset <= 0 || offset >= bytes.length) return offset;
  const byte = bytes[offset]!;
  if (!isContinuation(byte)) return offset;
  for (let lead = offset - 1; lead >= Math.max(0, offset - 3); lead -= 1) {
    const leadByte = bytes[lead]!;
    if (isContinuation(leadByte)) continue;
    const length = sequenceLength(leadByte);
    if (length < 2 || lead + length <= offset) return offset;
    return lead;
  }
  return offset;
}

function alignEnd(bytes: Uint8Array, start: number, desiredEnd: number): number {
  const end = Math.max(0, Math.min(desiredEnd, bytes.length));
  if (end <= start || end >= bytes.length) return end;
  const byte = bytes[end]!;
  if (!isContinuation(byte)) return end;
  for (let index = end - 1; index >= Math.max(start, end - 3); index -= 1) {
    const value = bytes[index]!;
    if (!isContinuation(value)) return index;
  }
  return end;
}

function createWindow(params: {
  bytes: Uint8Array;
  requestedOffset: number;
  length: number;
  version?: string;
  hasDecodingErrors?: (start: number, end: number) => boolean;
}): FileTextWindow {
  const totalBytes = params.bytes.length;
  const requested = Math.max(0, Math.min(params.requestedOffset, totalBytes));
  if (requested >= totalBytes) {
    return {
      path: "/work/file.txt",
      content: "",
      offset: totalBytes,
      bytesRead: 0,
      nextOffset: totalBytes,
      totalBytes,
      version: params.version ?? "v1",
      isBinary: false,
      eof: true,
      hasDecodingErrors: false,
      truncated: false,
    };
  }
  const start = alignStart(params.bytes, requested);
  const desiredEnd = Math.min(
    totalBytes,
    start + Math.min(params.length, FILE_TEXT_WINDOW_MAX_BYTES),
  );
  const end = alignEnd(params.bytes, start, desiredEnd);
  const raw = params.bytes.subarray(start, end);
  return {
    path: "/work/file.txt",
    content: decoder.decode(raw),
    offset: start,
    bytesRead: end - start,
    nextOffset: end,
    totalBytes,
    version: params.version ?? "v1",
    isBinary: false,
    eof: end >= totalBytes,
    hasDecodingErrors: params.hasDecodingErrors?.(start, end) ?? false,
    truncated: end < totalBytes,
  };
}

test("块参数固定为 256 KiB - 4，blockIndex 按原文件字节向下取整", () => {
  assert.equal(FILES_LARGE_TEXT_BLOCK_STEP, 262140);
  assert.equal(FILE_TEXT_WINDOW_MAX_BYTES, 262144);
  assert.equal(filesLargeTextBlockIndex(0), 0);
  assert.equal(filesLargeTextBlockIndex(FILES_LARGE_TEXT_BLOCK_STEP - 1), 0);
  assert.equal(filesLargeTextBlockIndex(FILES_LARGE_TEXT_BLOCK_STEP), 1);
  assert.equal(filesLargeTextBlockIndex(FILES_LARGE_TEXT_BLOCK_STEP * 3 + 7), 3);
  assert.equal(filesLargeTextBlockIndex(-5), 0);
  assert.equal(filesLargeTextBlockCount(0), 1);
  assert.equal(filesLargeTextBlockCount(1), 1);
  assert.equal(filesLargeTextBlockCount(FILES_LARGE_TEXT_BLOCK_STEP), 1);
  assert.equal(filesLargeTextBlockCount(FILES_LARGE_TEXT_BLOCK_STEP + 1), 2);
  assert.equal(filesLargeTextNominalBlockStart(2), FILES_LARGE_TEXT_BLOCK_STEP * 2);
  assert.equal(filesLargeTextNominalBlockEnd(2), FILES_LARGE_TEXT_BLOCK_STEP * 3);
});

test("UTF-8 边界只对合法 2/3/4 字节码点向更大字节偏移对齐，非法保持请求位置", () => {
  const cases: Array<{ text: string; position: number; expected: number }> = [
    { text: "AéB", position: 2, expected: 3 }, // é = 2 bytes, position 2 is its continuation
    { text: "A€B", position: 2, expected: 4 }, // € = 3 bytes
    { text: "A😀B", position: 2, expected: 5 }, // emoji = 4 bytes
    { text: "AB", position: 1, expected: 1 }, // ASCII 边界不移动
  ];
  for (const scenario of cases) {
    const bytes = encoder.encode(scenario.text);
    assert.equal(
      resolveFilesLargeTextAlignedBoundary(bytes, scenario.position),
      scenario.expected,
      scenario.text,
    );
  }
  // 非法 continuation 串保持请求偏移，不扫描任意长字节串。
  assert.equal(resolveFilesLargeTextAlignedBoundary(Uint8Array.from([0x41, 0x80, 0x80]), 1), 1);
  assert.equal(resolveFilesLargeTextAlignedBoundary(Uint8Array.from([0x80, 0x80, 0x80]), 1), 1);
});

test("名义边界落在合法码点内部时首块与次块连续、不重叠", () => {
  const firstBlock = "A".repeat(FILES_LARGE_TEXT_BLOCK_STEP - 1);
  const euro = "€";
  const bytes = encoder.encode(`${firstBlock}${euro}${"B".repeat(32)}`);
  const totalBytes = bytes.length;
  assert.ok(totalBytes > FILES_LARGE_TEXT_BLOCK_STEP);

  const block0 = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes,
    window: createWindow({
      bytes,
      requestedOffset: 0,
      length: FILE_TEXT_WINDOW_MAX_BYTES,
    }),
  });
  const block1 = sliceFilesLargeTextBlockWindow({
    blockIndex: 1,
    totalBytes,
    window: createWindow({
      bytes,
      requestedOffset: filesLargeTextNominalBlockStart(1),
      length: FILE_TEXT_WINDOW_MAX_BYTES,
    }),
  });

  assert.equal(block0.offset, 0);
  // € 从 262139 开始，跨过 262140；块 0 在它之后结束，块 1 从它之后开始。
  assert.equal(block0.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP + 2);
  assert.equal(block1.offset, block0.nextOffset);
  assert.equal(block0.nextOffset <= block1.nextOffset, true);
  assert.equal(block0.hasDecodingErrors, false);
  assert.equal(block1.hasDecodingErrors, false);
  assert.equal(block1.content.endsWith("B".repeat(32)), true);
  assert.equal(encoder.encode(block0.content).length, block0.nextOffset - block0.offset);
});

test("相邻块复用上一块 nextOffset 时服务不会再次向更小偏移回退", () => {
  const bytes = encoder.encode(`${"A".repeat(10)}😀${"B".repeat(10)}`);
  const blockIndex = 0;
  const slice = sliceFilesLargeTextBlockWindow({
    blockIndex,
    totalBytes: bytes.length,
    window: createWindow({
      bytes,
      requestedOffset: 0,
      length: FILE_TEXT_WINDOW_MAX_BYTES,
    }),
    knownStart: 0,
  });
  assert.equal(slice.offset, 0);
  assert.equal(slice.nextOffset, bytes.length);
});

test("最后一块直接到 EOF，空文件与块边界都覆盖", () => {
  const empty = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes: 0,
    window: createWindow({ bytes: new Uint8Array(), requestedOffset: 0, length: 256 }),
  });
  assert.deepEqual(
    { offset: empty.offset, nextOffset: empty.nextOffset, content: empty.content },
    { offset: 0, nextOffset: 0, content: "" },
  );

  const exactBoundary = encoder.encode("x".repeat(32));
  const boundarySlice = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes: exactBoundary.length,
    window: createWindow({
      bytes: exactBoundary,
      requestedOffset: 0,
      length: FILE_TEXT_WINDOW_MAX_BYTES,
    }),
  });
  assert.equal(boundarySlice.nextOffset, exactBoundary.length);
  assert.equal(boundarySlice.hasDecodingErrors, false);
});

test("初次窗口含非法字节时要求精确复核，复核后只读状态才落到本块", () => {
  const bytes = new Uint8Array(FILES_LARGE_TEXT_BLOCK_STEP + 16);
  bytes.fill(0x41);
  bytes[FILES_LARGE_TEXT_BLOCK_STEP - 2] = 0x80; // 非法 continuation
  const totalBytes = bytes.length;
  const firstWindow = createWindow({
    bytes,
    requestedOffset: 0,
    length: FILE_TEXT_WINDOW_MAX_BYTES,
    hasDecodingErrors: () => true,
  });

  const initial = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes,
    window: firstWindow,
  });
  assert.equal(initial.needsExactConfirmation, true);
  assert.equal(initial.hasDecodingErrors, true);
  assert.equal(initial.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP);

  const exactWindow = createWindow({
    bytes,
    requestedOffset: initial.offset,
    length: FILES_LARGE_TEXT_BLOCK_STEP,
    hasDecodingErrors: () => true,
  });
  const exact = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes,
    window: exactWindow,
    knownStart: initial.offset,
    exact: true,
  });
  assert.equal(exact.needsExactConfirmation, false);
  assert.equal(exact.hasDecodingErrors, true);
  assert.equal(exact.offset, initial.offset);
});

test("非法字节只存在于越界尾部时，精确复核后本块仍可编辑", () => {
  const bytes = new Uint8Array(FILES_LARGE_TEXT_BLOCK_STEP + 64);
  bytes.fill(0x41);
  // 错误在下一块范围（>= STEP），本块 [0, STEP) 全部合法。
  bytes[FILES_LARGE_TEXT_BLOCK_STEP + 1] = 0x80;
  const totalBytes = bytes.length;
  const initial = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes,
    window: createWindow({
      bytes,
      requestedOffset: 0,
      length: FILE_TEXT_WINDOW_MAX_BYTES,
      hasDecodingErrors: () => true,
    }),
  });
  assert.equal(initial.needsExactConfirmation, true);

  const exact = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes,
    window: createWindow({
      bytes,
      requestedOffset: initial.offset,
      length: FILES_LARGE_TEXT_BLOCK_STEP,
      hasDecodingErrors: (_start, end) => end > FILES_LARGE_TEXT_BLOCK_STEP,
    }),
    knownStart: initial.offset,
    exact: true,
  });
  assert.equal(exact.needsExactConfirmation, false);
  assert.equal(exact.hasDecodingErrors, false);
  assert.equal(exact.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP);
  assert.equal(exact.content.length, FILES_LARGE_TEXT_BLOCK_STEP);
});

test("边界探查得到的真实结束位置通过 knownEnd 传入，非法正文不再用重编码长度定位", () => {
  const bytes = new Uint8Array(FILES_LARGE_TEXT_BLOCK_STEP + 16);
  bytes.fill(0x41);
  bytes[8] = 0x80; // 块头非法字节：本块必须只读
  // 4 字节 emoji 从 nominalEnd - 1 开始，跨过名义边界 3 字节。
  bytes.set(encoder.encode("😀"), FILES_LARGE_TEXT_BLOCK_STEP - 1);
  const totalBytes = bytes.length;
  const raw = createWindow({
    bytes,
    requestedOffset: 0,
    length: FILE_TEXT_WINDOW_MAX_BYTES,
    hasDecodingErrors: () => true,
  });

  // 未提供 knownEnd 时保持旧的兼容值，但不再据此提交精确结果。
  const pending = sliceFilesLargeTextBlockWindow({ blockIndex: 0, totalBytes, window: raw });
  assert.equal(pending.needsExactConfirmation, true);
  assert.equal(pending.nextOffset, FILES_LARGE_TEXT_BLOCK_STEP);

  const knownEnd = FILES_LARGE_TEXT_BLOCK_STEP + 3;
  const probed = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes,
    window: raw,
    knownEnd,
  });
  assert.equal(probed.offset, 0);
  assert.equal(probed.nextOffset, knownEnd);
  assert.equal(probed.hasDecodingErrors, true);
  assert.equal(probed.needsExactConfirmation, true);

  // 精确窗口自身就是原始字节范围 [offset, knownEnd)；content 的替换字符
  // 重新编码后长度不同，坐标只能来自 knownEnd。
  const exactWindow = {
    ...createWindow({
      bytes: bytes.subarray(0, knownEnd),
      requestedOffset: 0,
      length: knownEnd,
      hasDecodingErrors: () => true,
    }),
    totalBytes,
  };
  const exact = sliceFilesLargeTextBlockWindow({
    blockIndex: 0,
    totalBytes,
    window: exactWindow,
    knownStart: 0,
    knownEnd,
    exact: true,
  });
  assert.equal(exact.offset, 0);
  assert.equal(exact.nextOffset, knownEnd);
  assert.equal(exact.hasDecodingErrors, true);
  assert.equal(exact.needsExactConfirmation, false);
  assert.equal(exact.content, decoder.decode(bytes.subarray(0, knownEnd)));
  assert.notEqual(encoder.encode(exact.content).length, knownEnd);
});

test("读取请求固定 256 KiB；精确复核只覆盖边界附近", () => {
  const request = filesLargeTextBlockReadRequest({
    blockIndex: 2,
    totalBytes: 10_000_000,
    expectedVersion: "v1",
  });
  assert.deepEqual(request, {
    offset: FILES_LARGE_TEXT_BLOCK_STEP * 2,
    length: FILE_TEXT_WINDOW_MAX_BYTES,
    expectedVersion: "v1",
  });

  const reused = filesLargeTextBlockReadRequest({
    blockIndex: 2,
    totalBytes: 10_000_000,
    startOffset: FILES_LARGE_TEXT_BLOCK_STEP * 2 + 2,
  });
  assert.equal(reused.offset, FILES_LARGE_TEXT_BLOCK_STEP * 2 + 2);
  assert.equal(reused.length, FILE_TEXT_WINDOW_MAX_BYTES);

  const exact = filesLargeTextExactBlockReadRequest({
    slice: { offset: 100, nextOffset: FILES_LARGE_TEXT_BLOCK_STEP },
    totalBytes: 10_000_000,
  });
  assert.equal(exact.offset, 100);
  assert.equal(exact.length, FILES_LARGE_TEXT_BLOCK_STEP - 100);
});
