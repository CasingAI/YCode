import assert from "node:assert/strict";
import test from "node:test";
import {
  PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL,
  buildPreviewTextLineIndex,
} from "../src/previewPaneVirtualTextLineIndex.js";

/**
 * 行索引的语义必须与 `code.split("\n")` 完全一致：
 * 虚拟视图的行号、空末行与 CRLF 显示都依赖这一点。
 */
function assertMatchesSplit(code: string): void {
  const index = buildPreviewTextLineIndex(code);
  const expected = code.split("\n");
  assert.equal(index.lineCount, expected.length, `lineCount: ${JSON.stringify(code)}`);
  for (let line = 0; line < expected.length; line += 1) {
    assert.equal(index.lineAt(line), expected[line], `line ${line}: ${JSON.stringify(code)}`);
  }
  // 越界读取返回空串，虚拟器 overscan 偶尔会问到最后一行之后。
  assert.equal(index.lineAt(expected.length), "");
  assert.equal(index.lineAt(-1), "");
  assert.equal(index.lineAt(1.5), "");
}

test("空正文、单行与纯换行都与 split 一致", () => {
  assertMatchesSplit("");
  assertMatchesSplit("a");
  assertMatchesSplit("\n");
  assertMatchesSplit("\n\n\n");
  assertMatchesSplit("a\nb");
  assertMatchesSplit("a\nb\n");
});

test("CRLF 的 \\r 属于行内容，不被吞掉", () => {
  const code = "line1\r\nline2\r\n";
  const index = buildPreviewTextLineIndex(code);
  assert.equal(index.lineCount, 3);
  assert.equal(index.lineAt(0), "line1\r");
  assert.equal(index.lineAt(1), "line2\r");
  assert.equal(index.lineAt(2), "");
  assertMatchesSplit(code);
});

test("空行、连续空行与末尾空行都保留原位置", () => {
  const code = "a\n\n\nb\n\n";
  const index = buildPreviewTextLineIndex(code);
  assert.deepEqual(
    Array.from({ length: index.lineCount }, (_, line) => index.lineAt(line)),
    ["a", "", "", "b", "", ""],
  );
  assertMatchesSplit(code);
});

test("长单行不产生额外行，也不复制整行以外内容", () => {
  const longLine = "x".repeat(2 * 1024 * 1024);
  const code = `${longLine}\ntail`;
  const index = buildPreviewTextLineIndex(code);
  assert.equal(index.lineCount, 2);
  assert.equal(index.lineAt(0).length, longLine.length);
  assert.equal(index.lineAt(1), "tail");
  assertMatchesSplit(code);
});

test("多行正文逐行与 split 对齐（含非 BMP 字符与 Unicode 换行符不误判）", () => {
  // U+2028/U+2029 不是 \n，不能当作行分隔；emoji 是 2 个 UTF-16 单元，
  // 偏移必须按 code unit 计算才能 slice 正确。
  const code = "😀中é\r\n\u2028sep\u2029\n\ttab\nend";
  assertMatchesSplit(code);
  const index = buildPreviewTextLineIndex(code);
  assert.equal(index.lineCount, 4);
  assert.equal(index.lineAt(0), "😀中é\r");
});

test("随机结构正文与 split 完全一致", () => {
  const alphabet = ["a", "b", "\n", "\r", "中", "😀", "\t", ""];
  let seed = 20261114;
  const nextRandom = (): number => {
    // 固定种子的 LCG：只需可复现，不需要密码学质量。
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round += 1) {
    let code = "";
    const length = Math.floor(nextRandom() * 40);
    for (let index = 0; index < length; index += 1) {
      code += alphabet[Math.floor(nextRandom() * alphabet.length)];
    }
    assertMatchesSplit(code);
  }
});

test("跨多个 checkpoint 的随机访问仍与 split 一致（含大量空行）", () => {
  // 5000 行，混合空行、CRLF、长行：checkpoint 只在每 256 行记录一次，
  // 其余行必须从最近 checkpoint 局部扫描得到。
  const lines: string[] = [];
  for (let line = 0; line < 5_000; line += 1) {
    if (line % 7 === 0) lines.push("");
    else if (line % 11 === 0) lines.push(`row-${line}\r`);
    else if (line === 2_048) lines.push("x".repeat(256 * 1024));
    else lines.push(`row-${line}`);
  }
  const code = lines.join("\n");
  const index = buildPreviewTextLineIndex(code);
  assert.equal(index.lineCount, lines.length);
  assert.equal(
    index.checkpointCount,
    Math.ceil(lines.length / PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL),
  );

  const probes = [0, 1, 255, 256, 257, 511, 512, 513, 1_024, 2_047, 2_048, 2_049, 4_999];
  for (const line of probes) {
    assert.equal(index.lineAt(line), lines[line], `probe ${line}`);
  }
  // 每个 checkpoint 边界前后都必须正确，边界附近最容易差一。
  for (let line = 0; line < lines.length; line += PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL) {
    for (const probe of [line, line + 1, line - 1]) {
      if (probe >= 0 && probe < lines.length) {
        assert.equal(index.lineAt(probe), lines[probe], `checkpoint probe ${probe}`);
      }
    }
  }
  assertMatchesSplit("a\n".repeat(1_000));
});

test("全换行正文的索引内存只随行数 / 256 增长", () => {
  // 最坏情况：每行只有 1 个字节（换行），行数 = 字符数。
  const lineCount = 100_000;
  const code = "\n".repeat(lineCount - 1);
  const index = buildPreviewTextLineIndex(code);
  assert.equal(index.lineCount, lineCount);
  assert.equal(
    index.checkpointCount,
    Math.ceil(lineCount / PREVIEW_LINE_INDEX_CHECKPOINT_INTERVAL),
  );
  // 常驻偏移字节数 = checkpointCount * 4，而不是 lineCount * 4。
  assert.ok(index.checkpointCount * 4 * 64 <= lineCount * 4);
  assert.equal(index.lineAt(0), "");
  assert.equal(index.lineAt(Math.floor(lineCount / 2)), "");
  assert.equal(index.lineAt(lineCount - 1), "");
  // 抽查若干位置，语义仍是 split 的空行。
  for (const probe of [1, 255, 256, 257, 51_200, 99_998]) {
    assert.equal(index.lineAt(probe), "", `probe ${probe}`);
  }
  assert.equal(index.lineCount, code.split("\n").length);
});
