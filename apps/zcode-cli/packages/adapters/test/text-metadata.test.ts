import assert from "node:assert/strict";
import test from "node:test";
import iconv from "iconv-lite";
import {
  createStreamingTextDecoder,
  decodeTextBuffer,
  detectTextEncoding,
} from "../src/fs/text-metadata.js";

// 读取端口的编码契约：只保留 BOM 与二进制控制字节两个便宜且确定的信号，其余一律
// 按 UTF-8 处理，解不出来的字节丢弃。读取永不因编码失败——中文三字节一字，按字节
// 截断时只有三分之一的截断点落在字符边界上，其余会被旧的中文编码往返猜测判成
// 「不支持的编码」，一份完全合法的中文文件因此读不出来。

test("非二进制内容一律判为 utf8", () => {
  assert.equal(detectTextEncoding(Buffer.from("中文内容", "utf8")), "utf8");
  assert.equal(detectTextEncoding(Buffer.from("plain ascii", "utf8")), "utf8");
  // 非法 UTF-8 字节不再被当成「不支持的编码」，只是解不出来而已。
  assert.equal(detectTextEncoding(Buffer.from([0x41, 0xc3, 0x28, 0x80, 0xe0, 0x80])), "utf8");
});

test("BOM 仍然优先于默认判定", () => {
  assert.equal(detectTextEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), "utf8");
  assert.equal(detectTextEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00])), "utf16le");
});

test("按字节截断在多字节字符中间：判为 utf8，内容不含替换字符", () => {
  const full = Buffer.from("中文内容", "utf8");
  assert.equal(full.byteLength, 12);
  // 前 10 字节 = 中(3) + 文(3) + 内(3) + 「容」的前 2 字节，尾部是一个残缺序列。
  const decoded = decodeTextBuffer({ buffer: full.subarray(0, 10), path: "/tmp/plan.md" });

  assert.equal(decoded.encoding, "utf8");
  assert.ok(!decoded.content.includes("\uFFFD"), "截断尾部不应留下替换字符");
  assert.equal(decoded.content, "中文内");
});

test("含 NUL 字节的文件仍被拒绝，不会被当文本吞下去", () => {
  assert.throws(
    () => decodeTextBuffer({ buffer: Buffer.from([0x41, 0x00, 0x42]), path: "/tmp/a.bin" }),
    isBinaryRejection,
  );
});

test("控制字节超过 30% 仍被拒绝", () => {
  const controlHeavy = Buffer.from(`${"\u0001".repeat(40)}tail`);
  assert.throws(
    () => decodeTextBuffer({ buffer: controlHeavy, path: "/tmp/a.bin" }),
    isBinaryRejection,
  );
});

test("显式指定中文编码仍然正确解码：删掉的是猜，不是能力", () => {
  const gbk = iconv.encode("中文字段", "gbk");
  assert.notEqual(gbk.toString("utf8"), "中文字段", "GBK 字节按 UTF-8 读确实是乱码");

  const decoded = decodeTextBuffer({ buffer: gbk, encoding: "gbk", path: "/tmp/gbk.txt" });
  assert.equal(decoded.encoding, "gbk");
  assert.equal(decoded.content, "中文字段");
});

test("流式解码：跨 chunk 切开的字符不会被当成坏字节丢掉", () => {
  const bytes = Buffer.from("中文内容", "utf8");
  const decoder = createStreamingTextDecoder("utf8");
  // 前 4 字节正好切在「文」中间。
  const content =
    decoder.write(bytes.subarray(0, 4)) + decoder.write(bytes.subarray(4)) + decoder.end();

  assert.equal(content, "中文内容");
  assert.ok(!content.includes("\uFFFD"));
});

function isBinaryRejection(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "FileSystemPortError" && /binary/i.test(error.message)
  );
}
