import { StringDecoder } from "node:string_decoder";
import {
  createFileSystemError,
  type FileSystemLineEndings,
  type FileSystemTextEncoding,
} from "@zcode/contracts";
import iconv from "iconv-lite";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
/** 显式指定时才走 iconv 的中文编码；端口不再替调用方猜。 */
const LEGACY_CHINESE_ENCODINGS = ["gb2312", "gbk", "gb18030"] as const;
const BINARY_CONTROL_BYTE_THRESHOLD = 0.3;
const UNDECODED_CHARACTER = "\uFFFD";
const NON_TEXT_ENCODINGS = new Set(["base64", "base64url", "hex"]);

type LegacyChineseEncoding = (typeof LEGACY_CHINESE_ENCODINGS)[number];

interface DecodedTextBuffer {
  content: string;
  encoding: FileSystemTextEncoding;
}

interface StreamingTextDecoder {
  write(buffer: Buffer): string;
  end(): string;
}

/**
 * 判定文本编码。刻意只保留两个便宜且确定的信号：BOM 与二进制控制字节，
 * 其余一律按 UTF-8 处理。
 *
 * 曾经这里还会把 GB2312/GBK/GB18030 逐个试往返来「猜」编码，猜不出就抛
 * `unsupported`。代价远超收益：读取端口几乎所有调用方都不指定编码，猜出来的
 * 结果只有 UTF-8 和三个中文编码两种走向，而中文编码这条走向在按字节截断的
 * 读取上必然误判——3 字节一个汉字，截断点只有 1/3 落在字符边界上，剩下的
 * 2/3 会被判成「不支持的编码」，一份完全合法的中文计划文件因此读不出来。
 * 现在删除猜测：解不出来的字节按替换字符处理并被丢弃，读取永不因编码失败。
 */
export function detectTextEncoding(buffer: Buffer, path?: string): FileSystemTextEncoding {
  if (buffer.length >= 3 && bytesStartWith(buffer, UTF8_BOM)) {
    return "utf8";
  }
  if (buffer.length >= 2 && bytesStartWith(buffer, UTF16LE_BOM)) {
    return "utf16le";
  }
  if (looksLikeBinary(buffer)) {
    throw createBinaryContentError(path);
  }
  return "utf8";
}

export function decodeTextBuffer(request: {
  buffer: Buffer;
  encoding?: FileSystemTextEncoding;
  path?: string;
}): DecodedTextBuffer {
  const encoding = request.encoding ?? detectTextEncoding(request.buffer, request.path);
  return {
    content: decodeBufferWithEncoding(request.buffer, encoding),
    encoding,
  };
}

export function encodeTextContent(request: {
  content: string;
  encoding?: FileSystemTextEncoding;
  path?: string;
}): Buffer {
  const encoding = request.encoding ?? "utf8";
  if (isLegacyChineseEncoding(encoding)) {
    const encoded = iconv.encode(request.content, encoding);
    assertLegacyEncodingRoundTrip({
      decoded: request.content,
      encoded,
      encoding,
      path: request.path,
    });
    return encoded;
  }
  return Buffer.from(request.content, encoding);
}

export function createStreamingTextDecoder(encoding: FileSystemTextEncoding): StreamingTextDecoder {
  if (isLegacyChineseEncoding(encoding)) {
    const decoder = iconv.getDecoder(encoding);
    return {
      write(buffer) {
        return dropUndecodableCharacters(decoder.write(buffer));
      },
      end() {
        return dropUndecodableCharacters(decoder.end() ?? "");
      },
    };
  }
  const decoder = new StringDecoder(encoding);
  return {
    write(buffer) {
      // StringDecoder 会把跨 chunk 切开的半个字符留在内部缓冲，只有真正解不出来的
      // 字节才会变成 U+FFFD，所以这里删掉的一定是噪音而不是原文。
      return dropUndecodableCharacters(decoder.write(buffer));
    },
    end() {
      return dropUndecodableCharacters(decoder.end());
    },
  };
}

export function shouldNormalizeLineEndings(encoding: FileSystemTextEncoding): boolean {
  return !NON_TEXT_ENCODINGS.has(normalizeEncodingName(encoding));
}

function decodeBufferWithEncoding(buffer: Buffer, encoding: FileSystemTextEncoding): string {
  if (isLegacyChineseEncoding(encoding)) {
    return dropUndecodableCharacters(iconv.decode(buffer, encoding));
  }
  return dropUndecodableCharacters(buffer.toString(encoding));
}

/**
 * 丢掉解不出来的字节留下的替换字符。读取端口的契约是「内容里不会出现 U+FFFD」：
 * 按 maxBytes 截断的读取必然在字节中间收尾，与调用方是不是显式要了某种编码无关。
 */
function dropUndecodableCharacters(content: string): string {
  return content.includes(UNDECODED_CHARACTER)
    ? content.replaceAll(UNDECODED_CHARACTER, "")
    : content;
}

function assertLegacyEncodingRoundTrip(request: {
  decoded: string;
  encoded: Buffer;
  encoding: LegacyChineseEncoding;
  path?: string;
}): void {
  if (iconv.decode(request.encoded, request.encoding) === request.decoded) return;
  throw createFileSystemError({
    code: "unsupported",
    path: request.path,
    message: `Content cannot be encoded as ${request.encoding}${
      request.path ? `: ${request.path}` : ""
    }`,
  });
}

function looksLikeBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let controlBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      controlBytes += 1;
    }
  }
  return controlBytes / buffer.length > BINARY_CONTROL_BYTE_THRESHOLD;
}

function bytesStartWith(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

function isLegacyChineseEncoding(
  encoding: FileSystemTextEncoding,
): encoding is LegacyChineseEncoding {
  return LEGACY_CHINESE_ENCODINGS.includes(encoding as LegacyChineseEncoding);
}

function normalizeEncodingName(encoding: FileSystemTextEncoding): string {
  return encoding.toLowerCase();
}

function createBinaryContentError(path?: string): Error {
  // 判定收敛后，读取失败只剩「确实是二进制」这一种原因；文案沿用既有措辞不再改动。
  return createFileSystemError({
    code: "unsupported",
    path,
    message: `Unsupported or binary text encoding${path ? `: ${path}` : ""}`,
  });
}

export function detectLineEndings(content: string): FileSystemLineEndings {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    if (index > 0 && content[index - 1] === "\r") {
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}

export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

export function applyRequestedLineEndings(
  content: string,
  lineEndings: FileSystemLineEndings | undefined,
): string {
  if (lineEndings === undefined) {
    return content;
  }
  const normalized = normalizeLineEndings(content);
  return lineEndings === "CRLF" ? normalized.split("\n").join("\r\n") : normalized;
}
