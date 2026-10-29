import assert from "node:assert/strict";
import test from "node:test";
import { FILE_TEXT_WINDOW_MAX_BYTES } from "@zcode/shared";
import {
  FILES_LARGE_TEXT_BLOCK_STEP_BYTES,
  clampFilesLargeTextOffset,
  formatFilesLargeTextByteCount,
  formatFilesLargeTextRange,
  isFilesLargeTextFragment,
  isFilesLargeTextRequestCurrent,
  isFilesLargeTextWatchEventForPath,
  normalizeFilesLargeTextWatchPath,
  resolveFilesLargeTextBlockIndex,
  resolveFilesLargeTextBlockNavigation,
  resolveFilesLargeTextBlockNominalOffset,
  resolveFilesLargeTextBlockNominalRange,
  resolveFilesLargeTextExpectedVersion,
  resolveFilesLargeTextLastBlockIndex,
  resolveFilesLargeTextNavigationOffset,
  resolveFilesLargeTextPosition,
} from "../src/files-workbench/filesLargeTextNavigation.js";

const GIB = 1024 * 1024 * 1024;

test("始 / 前 / 后 / 尾均为字节窗口，尾窗不扫描全文件", () => {
  const current = {
    offset: 4 * FILE_TEXT_WINDOW_MAX_BYTES,
    nextOffset: 5 * FILE_TEXT_WINDOW_MAX_BYTES,
    totalBytes: 4 * GIB,
    eof: false,
  };
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "start" },
      current,
      totalBytes: current.totalBytes,
    }),
    0,
  );
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "previous" },
      current,
      totalBytes: current.totalBytes,
    }),
    3 * FILE_TEXT_WINDOW_MAX_BYTES,
  );
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "next" },
      current,
      totalBytes: current.totalBytes,
    }),
    5 * FILE_TEXT_WINDOW_MAX_BYTES,
  );
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "end" },
      current,
      totalBytes: current.totalBytes,
    }),
    4 * GIB - FILE_TEXT_WINDOW_MAX_BYTES,
  );
});

test("EOF 上 next 与首窗 previous 都是空操作，不产生空窗请求", () => {
  const head = {
    offset: 0,
    nextOffset: FILE_TEXT_WINDOW_MAX_BYTES,
    totalBytes: 4 * GIB,
    eof: false,
  };
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "previous" },
      current: head,
      totalBytes: head.totalBytes,
    }),
    0,
  );
  const tail = {
    offset: 2 * FILE_TEXT_WINDOW_MAX_BYTES,
    nextOffset: 3 * FILE_TEXT_WINDOW_MAX_BYTES,
    totalBytes: 3 * FILE_TEXT_WINDOW_MAX_BYTES,
    eof: true,
  };
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "next" },
      current: tail,
      totalBytes: tail.totalBytes,
    }),
    tail.offset,
  );
});

test("显式百分比 100 与字节 totalBytes 仍允许空 EOF 定位", () => {
  const totalBytes = 10 * 1024 * 1024;
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "percent", percent: 100 },
      totalBytes,
    }),
    totalBytes,
  );
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "offset", offset: totalBytes },
      totalBytes,
    }),
    totalBytes,
  );
});

test("文件监视事件按规范化路径命中，不带 changedPath 时保守命中", () => {
  assert.equal(normalizeFilesLargeTextWatchPath("C:\\Work\\Huge.log"), "c:/work/huge.log");
  assert.equal(normalizeFilesLargeTextWatchPath("/work/huge.log/"), "/work/huge.log");
  assert.equal(
    isFilesLargeTextWatchEventForPath({ changedPath: "C:\\Work\\Huge.log" }, "c:/work/Huge.log"),
    true,
  );
  assert.equal(
    isFilesLargeTextWatchEventForPath({ changedPath: "/work/other.log" }, "/work/huge.log"),
    false,
  );
  assert.equal(isFilesLargeTextWatchEventForPath({}, "/work/huge.log"), true);
});

test("百分比与字节定位夹紧到 [0, totalBytes]，且是字节而不是行", () => {
  const totalBytes = 10 * 1024 * 1024 - 1;
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "percent", percent: 50 },
      totalBytes,
    }),
    Math.floor(totalBytes / 2),
  );
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "percent", percent: 100 },
      totalBytes,
    }),
    totalBytes,
  );
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "percent", percent: -20 },
      totalBytes,
    }),
    0,
  );
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "offset", offset: totalBytes + 999 },
      totalBytes,
    }),
    totalBytes,
  );
  assert.equal(
    resolveFilesLargeTextNavigationOffset({
      target: { kind: "offset", offset: -5 },
      totalBytes,
    }),
    0,
  );
  assert.equal(clampFilesLargeTextOffset(Number.NaN, totalBytes), 0);
});

test("片段标记覆盖 offset>0 或未到 EOF", () => {
  assert.equal(isFilesLargeTextFragment({ offset: 0, eof: true }), false);
  assert.equal(isFilesLargeTextFragment({ offset: 0, eof: false }), true);
  assert.equal(isFilesLargeTextFragment({ offset: 10, eof: true }), true);
  assert.equal(
    resolveFilesLargeTextPosition({ offset: 0, nextOffset: 10, totalBytes: 10, eof: true }),
    "head",
  );
  assert.equal(
    resolveFilesLargeTextPosition({ offset: 10, nextOffset: 20, totalBytes: 100, eof: false }),
    "middle",
  );
  assert.equal(
    resolveFilesLargeTextPosition({ offset: 90, nextOffset: 100, totalBytes: 100, eof: true }),
    "tail",
  );
  assert.equal(
    resolveFilesLargeTextPosition({ offset: 0, nextOffset: 0, totalBytes: 0, eof: true }),
    "empty",
  );
});

test("只有普通导航 / 重试带版本；首次读取与刷新接受新版本", () => {
  assert.equal(
    resolveFilesLargeTextExpectedVersion({ reason: "navigate", currentVersion: "v1" }),
    "v1",
  );
  assert.equal(
    resolveFilesLargeTextExpectedVersion({ reason: "retry", currentVersion: "v1" }),
    "v1",
  );
  assert.equal(
    resolveFilesLargeTextExpectedVersion({ reason: "refresh", currentVersion: "v1" }),
    undefined,
  );
  assert.equal(
    resolveFilesLargeTextExpectedVersion({ reason: "initial", currentVersion: "v1" }),
    undefined,
  );
});

test("迟到请求必须同时匹配 buffer、工作区、远程会话、路径、generation 与序号", () => {
  const current = {
    bufferId: "file:a:/f",
    workspaceKey: "a",
    remoteSessionId: "",
    path: "/f",
    generation: 2,
    requestSeq: 7,
  };
  assert.equal(isFilesLargeTextRequestCurrent({ ...current }, current), true);
  assert.equal(isFilesLargeTextRequestCurrent({ ...current, requestSeq: 6 }, current), false);
  assert.equal(isFilesLargeTextRequestCurrent({ ...current, generation: 1 }, current), false);
  assert.equal(isFilesLargeTextRequestCurrent({ ...current, path: "/g" }, current), false);
  assert.equal(
    isFilesLargeTextRequestCurrent({ ...current, remoteSessionId: "remote-1" }, current),
    false,
  );
  assert.equal(isFilesLargeTextRequestCurrent({ ...current, workspaceKey: "b" }, current), false);
});

test("块步长 = 256 KiB - 4，块索引按原文件字节坐标 floor 且与编辑无关", () => {
  assert.equal(FILES_LARGE_TEXT_BLOCK_STEP_BYTES, 262140);
  assert.ok(FILE_TEXT_WINDOW_MAX_BYTES - FILES_LARGE_TEXT_BLOCK_STEP_BYTES >= 4);

  assert.equal(resolveFilesLargeTextBlockIndex(0), 0);
  assert.equal(resolveFilesLargeTextBlockIndex(-1), 0);
  assert.equal(resolveFilesLargeTextBlockIndex(Number.NaN), 0);
  assert.equal(resolveFilesLargeTextBlockIndex(FILES_LARGE_TEXT_BLOCK_STEP_BYTES - 1), 0);
  assert.equal(resolveFilesLargeTextBlockIndex(FILES_LARGE_TEXT_BLOCK_STEP_BYTES), 1);
  assert.equal(resolveFilesLargeTextBlockIndex(2 * FILES_LARGE_TEXT_BLOCK_STEP_BYTES + 5), 2);
  // 1 GiB 稀疏文件也只做整数换算，不扫描全文。
  assert.equal(
    resolveFilesLargeTextBlockIndex(GIB - 1),
    Math.floor((GIB - 1) / FILES_LARGE_TEXT_BLOCK_STEP_BYTES),
  );
});

test("名义块区间连续、不重叠、无空洞，尾块夹到 EOF", () => {
  const totalBytes = 3 * FILES_LARGE_TEXT_BLOCK_STEP_BYTES + 17;
  for (let index = 0; index <= resolveFilesLargeTextLastBlockIndex(totalBytes); index += 1) {
    const range = resolveFilesLargeTextBlockNominalRange({ blockIndex: index, totalBytes });
    assert.equal(range.start, index * FILES_LARGE_TEXT_BLOCK_STEP_BYTES);
    assert.ok(range.end - range.start <= FILES_LARGE_TEXT_BLOCK_STEP_BYTES);
    const next = resolveFilesLargeTextBlockNominalRange({ blockIndex: index + 1, totalBytes });
    if (index < resolveFilesLargeTextLastBlockIndex(totalBytes)) {
      assert.equal(range.end, next.start);
    }
  }
  assert.equal(
    resolveFilesLargeTextBlockNominalRange({ blockIndex: 3, totalBytes }).end,
    totalBytes,
  );
  // 空文件固定为 block 0；正好落在块边界时最后一个含字节块是前一块。
  assert.equal(resolveFilesLargeTextLastBlockIndex(0), 0);
  assert.equal(resolveFilesLargeTextLastBlockIndex(FILES_LARGE_TEXT_BLOCK_STEP_BYTES), 0);
  assert.equal(resolveFilesLargeTextLastBlockIndex(FILES_LARGE_TEXT_BLOCK_STEP_BYTES + 1), 1);
});

test("始 / 前 / 后 / 尾按固定块移动；首次加载与空文件停在 block 0", () => {
  const totalBytes = 20 * FILES_LARGE_TEXT_BLOCK_STEP_BYTES + 100;
  const lastIndex = resolveFilesLargeTextLastBlockIndex(totalBytes);
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({ target: { kind: "start" }, currentBlockIndex: 7, totalBytes }),
    { blockIndex: 0, requestOffset: 0 },
  );
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "previous" },
      currentBlockIndex: 7,
      totalBytes,
    }),
    {
      blockIndex: 6,
      requestOffset: 6 * FILES_LARGE_TEXT_BLOCK_STEP_BYTES,
    },
  );
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "previous" },
      currentBlockIndex: 0,
      totalBytes,
    }),
    { blockIndex: 0, requestOffset: 0 },
  );
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "next" },
      currentBlockIndex: 7,
      totalBytes,
    }),
    { blockIndex: 8, requestOffset: 8 * FILES_LARGE_TEXT_BLOCK_STEP_BYTES },
  );
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "next" },
      currentBlockIndex: lastIndex,
      totalBytes,
    }),
    {
      blockIndex: lastIndex,
      requestOffset: lastIndex * FILES_LARGE_TEXT_BLOCK_STEP_BYTES,
    },
  );
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "next" },
      totalBytes,
    }),
    { blockIndex: 0, requestOffset: 0 },
  );
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({ target: { kind: "end" }, totalBytes }),
    {
      blockIndex: lastIndex,
      requestOffset: lastIndex * FILES_LARGE_TEXT_BLOCK_STEP_BYTES,
    },
  );
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({ target: { kind: "end" }, totalBytes: 0 }),
    { blockIndex: 0, requestOffset: 0 },
  );
});

test("字节 / 百分比定位用 floor(target / step) 选块，EOF 不越界", () => {
  const totalBytes = 10 * FILES_LARGE_TEXT_BLOCK_STEP_BYTES + 123;
  assert.deepEqual(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "offset", offset: 2 * FILES_LARGE_TEXT_BLOCK_STEP_BYTES + 5 },
      totalBytes,
    }),
    { blockIndex: 2, requestOffset: 2 * FILES_LARGE_TEXT_BLOCK_STEP_BYTES },
  );
  // 超出总大小夹紧到可定位范围，不产生越界块。
  const atEnd = resolveFilesLargeTextBlockNavigation({
    target: { kind: "offset", offset: totalBytes + 999 },
    totalBytes,
  });
  assert.equal(atEnd.blockIndex, Math.floor(totalBytes / FILES_LARGE_TEXT_BLOCK_STEP_BYTES));
  assert.ok(atEnd.requestOffset <= totalBytes);

  const halfOffset = Math.floor(totalBytes / 2);
  assert.equal(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "percent", percent: 50 },
      totalBytes,
    }).blockIndex,
    Math.floor(halfOffset / FILES_LARGE_TEXT_BLOCK_STEP_BYTES),
  );
  assert.equal(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "percent", percent: 100 },
      totalBytes,
    }).blockIndex,
    Math.floor(totalBytes / FILES_LARGE_TEXT_BLOCK_STEP_BYTES),
  );
  assert.equal(
    resolveFilesLargeTextBlockNavigation({
      target: { kind: "percent", percent: -20 },
      totalBytes,
    }).blockIndex,
    0,
  );
  // 名义起点永远是步长整数倍。
  assert.equal(
    resolveFilesLargeTextBlockNominalOffset(7) % FILES_LARGE_TEXT_BLOCK_STEP_BYTES,
    0,
  );
});

test("范围与大小展示保留精确字节边界", () => {
  assert.equal(formatFilesLargeTextRange({ offset: 0, nextOffset: 262144 }), "[0, 262144)");
  assert.equal(formatFilesLargeTextByteCount(0), "0 B");
  assert.equal(formatFilesLargeTextByteCount(1023), "1023 B");
  assert.equal(formatFilesLargeTextByteCount(1024), "1.00 KiB");
  assert.equal(formatFilesLargeTextByteCount(8 * 1024 * 1024), "8.00 MiB");
  assert.equal(formatFilesLargeTextByteCount(GIB), "1.00 GiB");
});
