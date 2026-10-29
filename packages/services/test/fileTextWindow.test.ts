import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FILE_TEXT_WINDOW_CHANGED_CODE,
  FILE_TEXT_WINDOW_INVALID_RANGE_CODE,
  FILE_TEXT_WINDOW_MAX_BYTES,
  FILE_TEXT_WINDOW_NOT_FILE_CODE,
  type FileTextWindow,
} from "@zcode/shared";
import { createFileService } from "../src/file/fileService.js";
import { readTextFileWindow as readTextFileWindowWithTestHooks } from "../src/file/fileTextWindow.js";

type FileService = ReturnType<typeof createFileService>;

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-file-window-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

async function assertUtf8Boundary(path: string, offset: number): Promise<void> {
  if (offset === 0) return;
  const info = await stat(path);
  // EOF 位置也是合法边界，但没有可读字节。
  if (offset >= info.size) return;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(buffer, 0, 1, offset);
    assert.equal(bytesRead, 1);
    assert.equal(isUtf8Continuation(buffer[0] ?? 0), false, `offset ${offset} 不是 UTF-8 边界`);
  } finally {
    await handle.close();
  }
}

async function readAllWindows(
  fileService: FileService,
  path: string,
  length = FILE_TEXT_WINDOW_MAX_BYTES,
): Promise<FileTextWindow[]> {
  const windows: FileTextWindow[] = [];
  let offset = 0;
  let expectedVersion: string | undefined;
  // 防御死循环：每个窗口至少前进 1 字节，迭代上限为总字节数 + 少量收尾请求。
  const totalBytes = (await fileService.readTextFileWindow({ path, offset: 0, length })).totalBytes;
  for (let index = 0; index <= totalBytes + 2; index += 1) {
    const window = await fileService.readTextFileWindow({ path, offset, length, expectedVersion });
    windows.push(window);
    assert.ok(window.bytesRead <= length, `bytesRead ${window.bytesRead} 超过请求长度 ${length}`);
    assert.ok(
      Buffer.byteLength(window.content) <= window.bytesRead,
      "content 字节数不应超过 bytesRead",
    );
    expectedVersion = window.version;
    if (window.eof) return windows;
    assert.ok(window.nextOffset > offset, `nextOffset ${window.nextOffset} 未前进`);
    offset = window.nextOffset;
  }
  throw new Error("读取窗口未在预期迭代次数内到达 EOF");
}

test("默认读取首窗最多 256KiB，按 nextOffset 拼接完整 ASCII 文件", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "ascii.txt");
    const text = "A".repeat(600 * 1024);
    await writeFile(path, text, "utf8");
    const fileService = createFileService();

    const first = await fileService.readTextFileWindow({ path });
    assert.equal(first.path, path);
    assert.equal(first.offset, 0);
    assert.equal(first.bytesRead, FILE_TEXT_WINDOW_MAX_BYTES);
    assert.equal(first.nextOffset, FILE_TEXT_WINDOW_MAX_BYTES);
    assert.equal(first.totalBytes, Buffer.byteLength(text));
    assert.equal(first.eof, false);
    assert.equal(first.isBinary, false);
    assert.ok(first.version.length > 0);
    assert.equal(first.content.length, FILE_TEXT_WINDOW_MAX_BYTES);

    const windows = await readAllWindows(fileService, path);
    assert.equal(windows.map((window) => window.content).join(""), text);
    assert.equal(windows.at(-1)?.eof, true);
    assert.equal(windows.at(-1)?.nextOffset, windows.at(-1)?.totalBytes);
    for (const window of windows) {
      assert.ok(window.bytesRead <= FILE_TEXT_WINDOW_MAX_BYTES);
      assert.equal(window.version, first.version);
    }
  });
});

test("请求长度超过 256KiB 时被硬夹紧", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "large.txt");
    await writeFile(path, "x".repeat(FILE_TEXT_WINDOW_MAX_BYTES + 1024), "utf8");
    const window = await createFileService().readTextFileWindow({
      path,
      offset: 0,
      length: 4 * 1024 * 1024,
    });
    assert.equal(window.bytesRead, FILE_TEXT_WINDOW_MAX_BYTES);
    assert.equal(Buffer.byteLength(window.content), FILE_TEXT_WINDOW_MAX_BYTES);
    assert.equal(window.eof, false);
  });
});

test("偏移落在 2/3/4 字节 UTF-8 字符中间时回溯到码点起始", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "utf8.txt");
    const parts = [
      "A",
      ...Array.from({ length: 20 }, () => "é"),
      ...Array.from({ length: 20 }, () => "中"),
      ...Array.from({ length: 20 }, () => "😀"),
    ];
    const text = parts.join("");
    await writeFile(path, text, "utf8");
    const fileService = createFileService();

    const byteStarts: number[] = [];
    let cursor = 0;
    for (const part of parts) {
      byteStarts.push(cursor);
      cursor += Buffer.byteLength(part);
    }
    const twoByteStart = byteStarts[1]!;
    const threeByteStart = byteStarts[21]!;
    const fourByteStart = byteStarts[41]!;
    assert.equal(text.slice(0, 1), "A");
    assert.equal(text.slice(1, 2), "é");
    assert.equal(text.slice(21, 22), "中");
    assert.equal(text.slice(41, 43), "😀");

    const cases = [
      { requested: twoByteStart + 1, aligned: twoByteStart, text: "é" },
      { requested: threeByteStart + 1, aligned: threeByteStart, text: "中" },
      { requested: fourByteStart + 2, aligned: fourByteStart, text: "😀" },
    ];
    for (const item of cases) {
      const window = await fileService.readTextFileWindow({
        path,
        offset: item.requested,
        length: FILE_TEXT_WINDOW_MAX_BYTES,
      });
      assert.equal(window.offset, item.aligned);
      assert.ok(window.offset < item.requested);
      assert.ok(window.content.startsWith(item.text));
      assert.equal(window.content.includes("\uFFFD"), false);
      assert.ok(window.nextOffset > window.offset);
      await assertUtf8Boundary(path, window.offset);
      await assertUtf8Boundary(path, window.nextOffset);
    }

    // 奇数长度让每个窗口都落在不同码点中间，拼接结果仍与原文逐字一致。
    const windows = await readAllWindows(fileService, path, 7);
    assert.equal(windows.map((window) => window.content).join(""), text);
    assert.equal(
      windows.some((window) => window.content.includes("\uFFFD")),
      false,
    );
  });
});

test("请求 offset 位于非法 continuation 串时保持请求值，不回退", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "invalid-continuation.bin");
    // 0x41 后的 0x80 串没有合法首字节，不能为了对齐回退到 0x41。
    const bytes = Buffer.from([0x41, 0x80, 0x80, 0x80, 0x80, 0x42]);
    await writeFile(path, bytes);
    const fileService = createFileService();

    for (const requested of [1, 2, 3, 4]) {
      const window = await fileService.readTextFileWindow({
        path,
        offset: requested,
        length: 4,
      });
      assert.equal(window.offset, requested, `offset ${requested} 不应回退`);
      assert.ok(window.nextOffset > requested, `offset ${requested} 的窗口未前进`);
      assert.equal(window.hasDecodingErrors, true);
    }
  });
});

test("文件尾截断的多字节序列按非法字节边界保留请求 offset", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "truncated-utf8.bin");
    // 0xE4 0xB8 是缺失尾字节的 3 字节序列，offset 2 不能回退到 0。
    await writeFile(path, Buffer.from([0x41, 0xe4, 0xb8]));
    const fileService = createFileService();

    const atContinuation = await fileService.readTextFileWindow({
      path,
      offset: 2,
      length: 4,
    });
    assert.equal(atContinuation.offset, 2);
    assert.equal(atContinuation.eof, true);
    assert.equal(atContinuation.hasDecodingErrors, true);

    const atLead = await fileService.readTextFileWindow({ path, offset: 1, length: 4 });
    assert.equal(atLead.offset, 1);
  });
});

test("固定块边界探查：合法码点内部回退，非法 continuation 保持 nominalStart", async () => {
  await withTempDir(async (directory) => {
    const BLOCK_STEP = 256 * 1024 - 4;
    const fileService = createFileService();

    // nominalStart 落在“中”的第二个字节上：探查回退到码点起点，正式块从码点之后开始。
    const validPath = join(directory, "valid-boundary.txt");
    const validPrefix = Buffer.alloc(BLOCK_STEP, 0x41);
    validPrefix[BLOCK_STEP - 1] = 0xe4;
    await writeFile(
      validPath,
      Buffer.concat([validPrefix, Buffer.from([0xb8, 0xad]), Buffer.from("tail")]),
    );
    const probe = await fileService.readTextFileWindow({
      path: validPath,
      offset: BLOCK_STEP,
      length: 4,
    });
    assert.equal(probe.offset, BLOCK_STEP - 1);
    assert.ok(probe.content.startsWith("中"));
    const actualStart = probe.offset + Buffer.byteLength("中");
    assert.equal(actualStart, BLOCK_STEP + 2);

    const block = await fileService.readTextFileWindow({
      path: validPath,
      offset: actualStart,
      length: FILE_TEXT_WINDOW_MAX_BYTES,
    });
    assert.equal(block.offset, actualStart, "正式块不得再次向前回退");
    assert.ok(block.content.startsWith("tail"));

    // nominalStart 位于非法 continuation 串：探查保持请求 offset，作为块边界。
    const invalidPath = join(directory, "invalid-boundary.bin");
    const invalidPrefix = Buffer.alloc(BLOCK_STEP, 0x41);
    invalidPrefix[BLOCK_STEP - 1] = 0x80;
    await writeFile(invalidPath, Buffer.concat([invalidPrefix, Buffer.from([0x80, 0x80, 0x42])]));
    const invalidProbe = await fileService.readTextFileWindow({
      path: invalidPath,
      offset: BLOCK_STEP,
      length: 4,
    });
    assert.equal(invalidProbe.offset, BLOCK_STEP);
    assert.equal(invalidProbe.hasDecodingErrors, true);
  });
});

test("CRLF 被窗口边界拆开时不丢字节、不做换行规范化", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "crlf.txt");
    const text = "ab\r\ncd\r\n".repeat(1000);
    await writeFile(path, text, "utf8");
    const windows = await readAllWindows(createFileService(), path, 5);
    assert.equal(windows.map((window) => window.content).join(""), text);
    assert.equal(
      windows.some((window) => window.content.includes("\n\r")),
      false,
    );
    assert.equal(
      windows.some((window) => window.content.endsWith("\r") || window.content.startsWith("\n")),
      true,
    );
  });
});

test("超长单行按窗口读取，不要求窗口包含换行", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "single-line.txt");
    const text = "0123456789".repeat(100 * 1024);
    await writeFile(path, text, "utf8");
    const windows = await readAllWindows(createFileService(), path);
    // 每窗最多 256 KiB，整份文件需要 4 个窗口。
    assert.equal(windows.length, 4);
    assert.equal(windows.map((window) => window.content).join(""), text);
  });
});

test("窗口读取遇到短读会继续读取直到合法 UTF-8 边界", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "short-read.txt");
    await writeFile(path, `aaaa©tail`, "utf8");
    const handle = await open(path, "r");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalRead = prototype.read as typeof handle.read;
    let readCalls = 0;
    prototype.read = async function (
      this: typeof handle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) {
      readCalls += 1;
      const injectedLength = readCalls === 2 ? Math.min(length, 5) : length;
      return originalRead.call(this, buffer, offset, injectedLength, position);
    };
    try {
      const window = await createFileService().readTextFileWindow({
        path,
        offset: 0,
        length: FILE_TEXT_WINDOW_MAX_BYTES,
      });
      assert.equal(readCalls >= 3, true);
      assert.equal(window.content, "aaaa©tail");
      assert.equal(window.hasDecodingErrors, false);
      assert.equal(window.nextOffset, Buffer.byteLength("aaaa©tail"));
      await assertUtf8Boundary(path, window.nextOffset);
    } finally {
      prototype.read = originalRead;
    }
  });
});

test("空文件、EOF 与超过末尾的偏移返回空窗口", async () => {
  await withTempDir(async (directory) => {
    const emptyPath = join(directory, "empty.txt");
    await writeFile(emptyPath, "");
    const fileService = createFileService();

    const empty = await fileService.readTextFileWindow({
      path: emptyPath,
      offset: 0,
      length: 1024,
    });
    assert.deepEqual(
      {
        content: empty.content,
        offset: empty.offset,
        bytesRead: empty.bytesRead,
        nextOffset: empty.nextOffset,
        totalBytes: empty.totalBytes,
        eof: empty.eof,
        isBinary: empty.isBinary,
      },
      {
        content: "",
        offset: 0,
        bytesRead: 0,
        nextOffset: 0,
        totalBytes: 0,
        eof: true,
        isBinary: false,
      },
    );
    assert.ok(empty.version.length > 0);
    assert.equal(empty.hasDecodingErrors, false);

    const path = join(directory, "small.txt");
    await writeFile(path, "abc", "utf8");
    const atEof = await fileService.readTextFileWindow({ path, offset: 3, length: 16 });
    assert.equal(atEof.content, "");
    assert.equal(atEof.offset, 3);
    assert.equal(atEof.bytesRead, 0);
    assert.equal(atEof.nextOffset, 3);
    assert.equal(atEof.totalBytes, 3);
    assert.equal(atEof.eof, true);
    assert.equal(atEof.hasDecodingErrors, false);

    const pastEof = await fileService.readTextFileWindow({ path, offset: 100, length: 16 });
    assert.equal(pastEof.content, "");
    assert.equal(pastEof.offset, 3);
    assert.equal(pastEof.nextOffset, 3);
    assert.equal(pastEof.totalBytes, 3);
    assert.equal(pastEof.eof, true);
  });
});

test("1～4 字节文件在 length=4 下完整返回，不截断码点", async () => {
  await withTempDir(async (directory) => {
    const fileService = createFileService();
    const cases = [
      { name: "one.txt", content: "A" },
      { name: "two.txt", content: "é" },
      { name: "three.txt", content: "中" },
      { name: "four.txt", content: "😀" },
    ];
    for (const item of cases) {
      const path = join(directory, item.name);
      await writeFile(path, item.content, "utf8");
      const expectedBytes = Buffer.byteLength(item.content);
      const window = await fileService.readTextFileWindow({ path, offset: 0, length: 4 });
      assert.equal(window.content, item.content, item.name);
      assert.equal(window.bytesRead, expectedBytes, item.name);
      assert.ok(window.bytesRead <= 4, `${item.name} bytesRead 超过 length`);
      assert.equal(window.nextOffset, expectedBytes);
      assert.equal(window.totalBytes, expectedBytes);
      assert.equal(window.eof, true);
      assert.equal(window.hasDecodingErrors, false);
      await assertUtf8Boundary(path, window.nextOffset);
    }

    // length=4 恰好容纳一个 4 字节码点：每窗返回一个 emoji，拼接后逐字一致。
    const path = join(directory, "four-byte-repeat.txt");
    await writeFile(path, "😀😀", "utf8");
    const windows = await readAllWindows(fileService, path, 4);
    assert.equal(windows.map((window) => window.content).join(""), "😀😀");
    assert.equal(
      windows.some((window) => window.content.includes("\uFFFD")),
      false,
    );
  });
});

test("非法 offset / length 以可识别错误码拒绝", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "range.txt");
    await writeFile(path, "hello", "utf8");
    const fileService = createFileService();
    const invalidParams = [
      { path, offset: -1, length: 8 },
      { path, offset: Number.NaN, length: 8 },
      { path, offset: Number.POSITIVE_INFINITY, length: 8 },
      { path, offset: 1.5, length: 8 },
      { path, offset: Number.MAX_SAFE_INTEGER + 1, length: 8 },
      { path, offset: 0, length: 0 },
      { path, offset: 0, length: -1 },
      { path, offset: 0, length: 1 },
      { path, offset: 0, length: 2 },
      { path, offset: 0, length: 3 },
      { path, offset: 0, length: Number.NaN },
      { path, offset: 0, length: Number.POSITIVE_INFINITY },
      { path, offset: 0, length: 1.5 },
      { path, offset: 0, length: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const params of invalidParams) {
      await assert.rejects(
        fileService.readTextFileWindow(params),
        hasCode(FILE_TEXT_WINDOW_INVALID_RANGE_CODE),
        JSON.stringify(params),
      );
    }
  });
});

test("目录以 NOT_FILE 错误码拒绝", async () => {
  await withTempDir(async (directory) => {
    await assert.rejects(
      createFileService().readTextFileWindow({ path: directory, offset: 0, length: 8 }),
      hasCode(FILE_TEXT_WINDOW_NOT_FILE_CODE),
    );
  });
});

test("expectedVersion 不匹配时拒绝且不返回混合版本内容", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "version.txt");
    await writeFile(path, "first version\n", "utf8");
    const fileService = createFileService();

    const first = await fileService.readTextFileWindow({ path, offset: 0, length: 1024 });
    const same = await fileService.readTextFileWindow({
      path,
      offset: 0,
      length: 1024,
      expectedVersion: first.version,
    });
    assert.equal(same.content, first.content);
    assert.equal(same.version, first.version);

    await writeFile(path, "second version with different bytes\n", "utf8");
    await assert.rejects(
      fileService.readTextFileWindow({
        path,
        offset: 0,
        length: 1024,
        expectedVersion: first.version,
      }),
      hasCode(FILE_TEXT_WINDOW_CHANGED_CODE),
    );

    const refreshed = await fileService.readTextFileWindow({ path, offset: 0, length: 1024 });
    assert.equal(refreshed.content, "second version with different bytes\n");
    assert.notEqual(refreshed.version, first.version);
    assert.equal(refreshed.totalBytes, Buffer.byteLength("second version with different bytes\n"));
  });
});

test("expectedVersion 请求在 open 遇到 ENOENT 时返回 CHANGED，初读保留 ENOENT", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "disappeared.txt");
    await writeFile(path, "first window\n", "utf8");
    const fileService = createFileService();
    const first = await fileService.readTextFileWindow({ path, offset: 0, length: 64 });
    assert.ok(first.version.length > 0);

    await rm(path);

    await assert.rejects(
      fileService.readTextFileWindow({
        path,
        offset: 0,
        length: 64,
        expectedVersion: first.version,
      }),
      hasCode(FILE_TEXT_WINDOW_CHANGED_CODE),
    );

    // 没有 expectedVersion 的首次读取仍应透传 ENOENT，保存流程据此判断可新建。
    await assert.rejects(
      fileService.readTextFileWindow({ path, offset: 0, length: 64 }),
      hasCode("ENOENT"),
    );
  });
});

test("读取期间路径被 atomic 替换、删除或同 inode 追加时返回 CHANGED", async () => {
  await withTempDir(async (directory) => {
    const original = "original-content";
    // Windows 不允许 rename 覆盖仍被打开的路径，因此替换统一使用 rm + rename；
    // 探针确认删除打开中的路径可行，且替换后 ino 改变。
    const replaceFile = async (path: string): Promise<void> => {
      const replacement = `${path}.replacement`;
      await writeFile(replacement, "replacement-content", "utf8");
      await rm(path, { force: true });
      await rename(replacement, path);
    };
    const cases: Array<{
      label: string;
      content: string;
      offset: number;
      mutate: (path: string) => Promise<void>;
    }> = [
      {
        label: "normal 分支 atomic 替换",
        content: original,
        offset: 0,
        mutate: replaceFile,
      },
      {
        label: "EOF 分支 atomic 替换",
        content: original,
        offset: Buffer.byteLength(original),
        mutate: replaceFile,
      },
      {
        label: "路径删除",
        content: original,
        offset: 0,
        mutate: async (path) => {
          await rm(path);
        },
      },
      {
        label: "同一 inode 追加",
        content: original,
        offset: 0,
        mutate: async (path) => {
          await appendFile(path, "-appended", "utf8");
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const path = join(directory, `changed-${index}.txt`);
      await writeFile(path, item.content, "utf8");
      await assert.rejects(
        readTextFileWindowWithTestHooks(
          { path, offset: item.offset, length: 64 },
          { afterOpen: () => item.mutate(path) },
        ),
        hasCode(FILE_TEXT_WINDOW_CHANGED_CODE),
        item.label,
      );
    }
  });
});

test("首窗二进制返回空 content，非首窗只用文件头 sample 判定", async () => {
  await withTempDir(async (directory) => {
    const binaryPath = join(directory, "binary.bin");
    await writeFile(binaryPath, Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
    const fileService = createFileService();

    const binary = await fileService.readTextFileWindow({
      path: binaryPath,
      offset: 0,
      length: 1024,
    });
    assert.equal(binary.isBinary, true);
    assert.equal(binary.content, "");
    assert.equal(binary.bytesRead, 8);
    assert.equal(binary.eof, true);
    assert.equal(binary.hasDecodingErrors, false);

    // 头部文本 + 远离头 sample 的 NUL：尾窗口按文件头判定，不因窗口内的零字节误判二进制。
    const textThenZerosPath = join(directory, "text-then-zeros.bin");
    const header = Buffer.from("header text\n", "utf8");
    const body = Buffer.concat([header, Buffer.alloc(8 * 1024, 0x41), Buffer.alloc(32, 0)]);
    await writeFile(textThenZerosPath, body);
    const tail = await fileService.readTextFileWindow({
      path: textThenZerosPath,
      offset: header.length + 8 * 1024 + 4,
      length: 8,
    });
    assert.equal(tail.isBinary, false);
    assert.equal(tail.content, "\0".repeat(8));
    assert.equal(tail.bytesRead, 8);
    assert.equal(tail.hasDecodingErrors, false);
  });
});

test("非法 UTF-8 允许替换字符，但 nextOffset 必须单调前进并最终到达 EOF", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "invalid-utf8.bin");
    const bytes = Buffer.from([
      0x41, 0xe4, 0xb8, 0x42, 0xff, 0x43, 0x80, 0x80, 0x80, 0x80, 0x44, 0x45,
    ]);
    await writeFile(path, bytes);
    const fileService = createFileService();

    let offset = 0;
    let sawReplacement = false;
    let iterations = 0;
    for (; iterations <= bytes.length + 2; iterations += 1) {
      const window = await fileService.readTextFileWindow({ path, offset, length: 4 });
      if (window.content.includes("\uFFFD")) sawReplacement = true;
      // 原始窗口字节含非法序列时置位；内容中的 U+FFFD 只可能来自本次解码失败。
      assert.equal(
        window.hasDecodingErrors,
        window.content.includes("\uFFFD"),
        `offset ${window.offset} 的 hasDecodingErrors 与替换字符不一致`,
      );
      if (window.eof) {
        assert.equal(window.nextOffset, bytes.length);
        break;
      }
      assert.ok(window.nextOffset > offset, `nextOffset ${window.nextOffset} 未前进`);
      offset = window.nextOffset;
    }
    assert.ok(iterations <= bytes.length + 2);
    assert.equal(sawReplacement, true);
  });
});

test("文件内合法 U+FFFD 不标记解码错误", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "valid-replacement.txt");
    const text = "A\uFFFDB中文😀\uFFFD";
    await writeFile(path, text, "utf8");
    const fileService = createFileService();

    const first = await fileService.readTextFileWindow({
      path,
      offset: 0,
      length: FILE_TEXT_WINDOW_MAX_BYTES,
    });
    assert.equal(first.content, text);
    assert.equal(first.content.includes("\uFFFD"), true);
    assert.equal(first.hasDecodingErrors, false);

    // length=4 会频繁切在码点中间；对齐后每个窗口的原始字节仍应是合法 UTF-8。
    const windows = await readAllWindows(fileService, path, 4);
    assert.equal(windows.map((window) => window.content).join(""), text);
    assert.equal(
      windows.some((window) => window.hasDecodingErrors),
      false,
    );
  });
});

test("非法 UTF-8 位于文件尾时 EOF 窗口标记解码错误", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "invalid-at-eof.bin");
    // 3 字节 UTF-8 序列缺少最后一个字节，且正好在文件尾。
    await writeFile(path, Buffer.from([0x41, 0xe4, 0xb8]));
    const window = await createFileService().readTextFileWindow({
      path,
      offset: 0,
      length: 4,
    });

    assert.equal(window.eof, true);
    assert.equal(window.bytesRead, 3);
    assert.equal(window.nextOffset, 3);
    assert.equal(window.hasDecodingErrors, true);
    assert.ok(window.content.startsWith("A"));
    assert.ok(window.content.includes("\uFFFD"));
  });
});

test("大于 1GiB 的稀疏文件尾窗口只读有界字节并能看到尾部 marker", { timeout: 60_000 }, async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "sparse-1g.txt");
    const totalBytes = 1024 * 1024 * 1024 + 4096;
    const header = Buffer.alloc(64 * 1024, 0x20);
    header.write("SPARSE HEADER TEXT\n".repeat(512), 0, "utf8");
    const marker = "\nTAIL_MARKER_END\n";
    const tail = Buffer.alloc(FILE_TEXT_WINDOW_MAX_BYTES, 0x41);
    tail.write(marker, tail.length - Buffer.byteLength(marker), "utf8");

    const handle = await open(path, "w+");
    try {
      await handle.truncate(totalBytes);
      await handle.write(header, 0, header.length, 0);
      await handle.write(tail, 0, tail.length, totalBytes - tail.length);
    } finally {
      await handle.close();
    }

    const fileService = createFileService();
    const tailOffset = totalBytes - FILE_TEXT_WINDOW_MAX_BYTES;
    const startedAt = performance.now();
    const window = await fileService.readTextFileWindow({
      path,
      offset: tailOffset,
      length: FILE_TEXT_WINDOW_MAX_BYTES,
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(window.offset, tailOffset);
    assert.equal(window.bytesRead, FILE_TEXT_WINDOW_MAX_BYTES);
    assert.equal(window.nextOffset, totalBytes);
    assert.equal(window.totalBytes, totalBytes);
    assert.equal(window.eof, true);
    assert.equal(window.isBinary, false);
    assert.equal(window.content.length, FILE_TEXT_WINDOW_MAX_BYTES);
    assert.ok(window.content.endsWith(marker));
    // 若实现整文件 readFile，1GiB 读取会明显超过该阈值；窗口读只触碰头 sample 与尾窗口。
    assert.ok(elapsedMs < 15_000, `尾窗口读取耗时 ${elapsedMs.toFixed(0)}ms`);

    const middle = await fileService.readTextFileWindow({
      path,
      offset: Math.floor(totalBytes / 2),
      length: 64,
    });
    assert.equal(middle.offset, Math.floor(totalBytes / 2));
    assert.equal(middle.totalBytes, totalBytes);
    assert.equal(middle.isBinary, false);
    assert.equal(middle.content, "\0".repeat(64));
  });
});
