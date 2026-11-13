import assert from "node:assert/strict";
import test from "node:test";
import { FILE_TEXT_WINDOW_MAX_BYTES, type FileTextSlice, type FileTextWindow } from "@zcode/shared";
import {
  PREVIEW_VIRTUAL_TEXT_MAX_LINES,
  PREVIEW_VIRTUAL_TEXT_MIN_CHARS,
  isPreviewTextWindowUnavailableError,
  readPreviewPaneText,
  resolvePreviewPaneTextNoticeIds,
  resolvePreviewPaneTextReadState,
  shouldUseVirtualizedPreviewText,
} from "../src/previewPaneTextRead.js";

const PATH = "/workspace/data.json";

function createWindow(
  text: string,
  offset: number,
  length: number,
  options?: {
    version?: string;
    isBinary?: boolean;
    hasDecodingErrors?: boolean;
  },
): FileTextWindow {
  const end = Math.min(text.length, offset + length);
  return {
    path: PATH,
    content: text.slice(offset, end),
    offset,
    bytesRead: end - offset,
    nextOffset: end,
    totalBytes: text.length,
    version: options?.version ?? "v1",
    isBinary: options?.isBinary ?? false,
    eof: end === text.length,
    hasDecodingErrors: options?.hasDecodingErrors ?? false,
  };
}

function createReader(
  text: string,
  options?: {
    changeVersionAfterFirst?: boolean;
    binary?: boolean;
    decodingError?: boolean;
    missingWindowMethod?: boolean;
    legacySlice?: FileTextSlice;
    onLegacyRead?: () => void;
  },
) {
  let reads = 0;
  return {
    windowReads: () => reads,
    async readTextFileWindow(params: {
      path: string;
      offset?: number;
      length?: number;
      expectedVersion?: string;
    }) {
      if (options?.missingWindowMethod) {
        throw new Error("Method not found: readTextFileWindow");
      }
      reads += 1;
      const offset = params.offset ?? 0;
      const window = createWindow(
        text,
        offset,
        Math.min(params.length ?? FILE_TEXT_WINDOW_MAX_BYTES, FILE_TEXT_WINDOW_MAX_BYTES),
        {
          version: options?.changeVersionAfterFirst && reads > 1 ? "v2" : "v1",
          isBinary: options?.binary,
          hasDecodingErrors: options?.decodingError === true,
        },
      );
      if (options?.decodingError) {
        return { ...window, eof: false };
      }
      return window;
    },
    async readTextFile() {
      options?.onLegacyRead?.();
      if (!options?.legacySlice) {
        throw new Error("legacy read was not expected");
      }
      return options.legacySlice;
    },
  };
}

test("合法 UTF-8 多窗口读取拼接完整正文，不截断", async () => {
  const head = "START_MARKER\n";
  const body = "0123456789abcdef".repeat(40_000);
  const tail = "\nEND_MARKER";
  const text = head + body + tail;
  assert.ok(text.length > FILE_TEXT_WINDOW_MAX_BYTES);

  const reader = createReader(text);
  const read = await readPreviewPaneText(reader, PATH);
  assert.equal(read.kind, "window");
  if (read.kind !== "window") return;
  assert.equal(read.result.mode, "editable");
  const state = resolvePreviewPaneTextReadState(read, PATH);
  assert.equal(state.filePreview.content, text);
  assert.equal(state.filePreview.truncated, false);
  assert.equal(state.truncated, false);
  assert.equal(state.encodingInvalid, false);
  assert.ok(reader.windowReads() > 1);
});

test("9.7 MiB 合法 UTF-8 文本经共享读取器完整进入预览，不再做本地大小判断", async () => {
  const text = "a".repeat(Math.round(9.7 * 1024 * 1024));
  const reader = createReader(text);
  const read = await readPreviewPaneText(reader, PATH);
  assert.equal(read.kind, "window");
  if (read.kind !== "window") return;
  assert.equal(read.result.mode, "editable");
  const state = resolvePreviewPaneTextReadState(read, PATH);
  assert.equal(state.filePreview.content, text);
  assert.equal(state.filePreview.content.length, text.length);
  assert.equal(state.filePreview.totalBytes, text.length);
  assert.equal(state.truncated, false);
  assert.equal(state.encodingInvalid, false);
  assert.equal(state.tooLarge, false);
  assert.deepEqual(resolvePreviewPaneTextNoticeIds(state), []);
  assert.ok(reader.windowReads() > 1);
});

test("超过单字符串硬上限时只展示首窗前缀并提示过大", () => {
  const firstWindow: FileTextWindow = {
    path: PATH,
    content: "prefix",
    offset: 0,
    bytesRead: 6,
    nextOffset: 6,
    totalBytes: 2 ** 29,
    version: "v1",
    isBinary: false,
    eof: false,
    hasDecodingErrors: false,
  };
  const state = resolvePreviewPaneTextReadState(
    {
      kind: "window",
      result: {
        mode: "too-large",
        totalBytes: firstWindow.totalBytes,
        version: "v1",
        firstWindow,
      },
    },
    PATH,
  );
  assert.equal(state.filePreview.content, "prefix");
  assert.equal(state.truncated, true);
  assert.equal(state.encodingInvalid, false);
  assert.equal(state.tooLarge, true);
  assert.deepEqual(resolvePreviewPaneTextNoticeIds(state), ["codeViewer.textPreviewTooLarge"]);
});

test("二进制结果继续显示二进制提示，不当作空文本", () => {
  const state = resolvePreviewPaneTextReadState(
    { kind: "window", result: { mode: "binary", totalBytes: 1234, version: "v1" } },
    PATH,
  );
  assert.equal(state.filePreview.isBinary, true);
  assert.equal(state.filePreview.content, "");
  assert.equal(state.truncated, false);
});

test("非法 UTF-8 只读前缀保留已读内容，只提示编码错误而不误报 Host 截断", async () => {
  const text = "x".repeat(300 * 1024);
  const reader = createReader(text, { decodingError: true });
  const read = await readPreviewPaneText(reader, PATH);
  assert.equal(read.kind, "window");
  if (read.kind !== "window") return;
  assert.equal(read.result.mode, "large-text");
  const state = resolvePreviewPaneTextReadState(read, PATH);
  assert.equal(state.encodingInvalid, true);
  assert.equal(state.truncated, true);
  assert.equal(state.filePreview.content.length, FILE_TEXT_WINDOW_MAX_BYTES);
  // 编码错误导致的只读前缀不是旧 Host 能力缺失，不能再叠加 Host 截断提示。
  assert.deepEqual(resolvePreviewPaneTextNoticeIds(state), ["codeViewer.textPreviewEncoding"]);
});

test("旧 Host 缺少窗口读取时回退 readTextFile，保留前缀而不是清空正文", async () => {
  let legacyReads = 0;
  const legacySlice: FileTextSlice = {
    path: PATH,
    content: "legacy-prefix",
    offset: 0,
    bytesRead: 13,
    totalBytes: 300 * 1024,
    truncated: true,
    isBinary: false,
  };
  const reader = createReader("", {
    missingWindowMethod: true,
    legacySlice,
    onLegacyRead: () => {
      legacyReads += 1;
    },
  });
  const read = await readPreviewPaneText(reader, PATH);
  assert.equal(read.kind, "legacy");
  assert.equal(legacyReads, 1);
  const state = resolvePreviewPaneTextReadState(read, PATH);
  assert.equal(state.filePreview.content, "legacy-prefix");
  assert.equal(state.truncated, true);
  assert.equal(state.encodingInvalid, false);
  assert.deepEqual(resolvePreviewPaneTextNoticeIds(state), ["codeViewer.textPreviewTruncated"]);
});

test("非「方法不存在」的读取错误不降级为旧读取", async () => {
  const reader = createReader("", {
    legacySlice: {
      path: PATH,
      content: "",
      offset: 0,
      bytesRead: 0,
      totalBytes: 0,
      truncated: false,
      isBinary: false,
    },
  });
  reader.readTextFileWindow = async () => {
    throw new Error("permission denied");
  };
  await assert.rejects(() => readPreviewPaneText(reader, PATH), /permission denied/);
});

test("读取期间版本变化整次失败，不拼接混合版本正文", async () => {
  const text = "z".repeat(300 * 1024);
  const reader = createReader(text, { changeVersionAfterFirst: true });
  await assert.rejects(
    () => readPreviewPaneText(reader, PATH),
    /File changed while reading complete text/,
  );
});

test("仅识别 readTextFileWindow 方法缺失为旧 Host", () => {
  assert.equal(
    isPreviewTextWindowUnavailableError(new Error("Method not found: readTextFileWindow")),
    true,
  );
  assert.equal(
    isPreviewTextWindowUnavailableError(new Error("Method not found: readFileRange")),
    false,
  );
  assert.equal(isPreviewTextWindowUnavailableError(new Error("permission denied")), false);
});

test("超过 1 MiB 或 20,000 行走虚拟行视图，普通文本保持 CodeViewer", () => {
  assert.equal(shouldUseVirtualizedPreviewText(""), false);
  assert.equal(shouldUseVirtualizedPreviewText("const value = 1;\n"), false);
  assert.equal(
    shouldUseVirtualizedPreviewText("a".repeat(PREVIEW_VIRTUAL_TEXT_MIN_CHARS + 1)),
    true,
  );
  assert.equal(
    shouldUseVirtualizedPreviewText(
      Array.from({ length: PREVIEW_VIRTUAL_TEXT_MAX_LINES + 1 }, () => "x").join("\n"),
    ),
    true,
  );
  assert.equal(
    shouldUseVirtualizedPreviewText(
      Array.from({ length: PREVIEW_VIRTUAL_TEXT_MAX_LINES - 1 }, () => "x").join("\n"),
    ),
    false,
  );
});
