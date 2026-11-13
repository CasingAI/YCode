import assert from "node:assert/strict";

import {
  LEGACY_BLOCK_STEP,
  LEGACY_LARGE_FILE_BYTES,
  TARGET_BYTES,
  TARGET_LINES,
  TOKENS,
} from "./constants.mjs";

/**
 * 生成与用户报告一致的合法 JSON：约 9.7 MiB / 399194 行。
 *
 * 关键布局：
 * - 包含 262140 字节的那一行里面同时放下 boundaryLeft（该偏移之前）与
 *   boundaryRight（该偏移及之后）两个唯一 token，整行横跨旧 262140 字节块边界；
 * - 旧 8 MiB 阈值之后另放一个唯一 token；
 * - 最后一行数据行放尾部 marker；
 * - 剩余字节用 'x' 填充到精确的 10174816 字节，保持行数与合法 JSON。
 *
 * 夹具只生成数据；读取、分窗、解码、编辑、保存全部走生产路径。
 */

const DATA_ROWS = TARGET_LINES - 2; // 首行 `[` + 数据行 + 末行 `]`

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function renderLines(values) {
  const lines = ["["];
  for (let index = 0; index < values.length; index += 1) {
    lines.push(
      `{"id":${index},"value":"${values[index]}"}${index < values.length - 1 ? "," : ""}`,
    );
  }
  lines.push("]");
  return lines.join("\n");
}

function dataIndexAtOffset(starts, offset) {
  for (let index = 0; index < DATA_ROWS; index += 1) {
    const start = starts[index + 1];
    const next = starts[index + 2];
    if (start <= offset && offset < next) return index;
  }
  throw new Error(`fixture offset ${offset} 不在任何数据行内`);
}

function valueStartInLine(line, rowIndex) {
  const prefix = `{"id":${rowIndex},"value":"`;
  const local = line.indexOf(prefix);
  assert.ok(local >= 0, `未找到第 ${rowIndex} 行的 value 起点`);
  return local + prefix.length;
}

export function buildLargeJsonFixture() {
  const values = Array.from({ length: DATA_ROWS }, () => "");

  let text = renderLines(values);
  let starts = lineStarts(text);

  // 1. 选择跨 262140 的数据行，把左右 token 放在同一行的 value 内。
  let boundaryIndex = dataIndexAtOffset(starts, LEGACY_BLOCK_STEP);
  const boundaryLine = text.slice(starts[boundaryIndex + 1], starts[boundaryIndex + 2]);
  const valueStart =
    starts[boundaryIndex + 1] + valueStartInLine(boundaryLine, boundaryIndex);
  const filler = Math.max(
    0,
    LEGACY_BLOCK_STEP - (valueStart + TOKENS.boundaryLeft.length),
  );
  values[boundaryIndex] =
    TOKENS.boundaryLeft + "x".repeat(filler) + TOKENS.boundaryRight;

  text = renderLines(values);
  starts = lineStarts(text);

  const leftStart = text.indexOf(TOKENS.boundaryLeft);
  const rightStart = text.indexOf(TOKENS.boundaryRight);
  assert.ok(leftStart < LEGACY_BLOCK_STEP, `left token 应早于 262140，实际 ${leftStart}`);
  assert.ok(rightStart >= LEGACY_BLOCK_STEP, `right token 应不早于 262140，实际 ${rightStart}`);
  assert.equal(
    dataIndexAtOffset(starts, LEGACY_BLOCK_STEP),
    boundaryIndex,
    "跨块行在写入 token 后仍应覆盖 262140",
  );

  // 2. 旧 8 MiB 阈值之后的一行放唯一 token。
  const eightMiBIndex = dataIndexAtOffset(starts, LEGACY_LARGE_FILE_BYTES);
  const pastEightMiBIndex = eightMiBIndex + 1;
  assert.ok(pastEightMiBIndex < DATA_ROWS - 1);
  values[pastEightMiBIndex] = TOKENS.pastEightMiB;

  // 3. 最后一行数据行放尾部 marker。
  values[DATA_ROWS - 1] = TOKENS.tail;

  text = renderLines(values);
  const beforePadding = Buffer.byteLength(text, "utf8");
  const delta = TARGET_BYTES - beforePadding;
  assert.ok(delta > 0, `填充前已超过目标大小：${beforePadding}`);
  const paddingRows = DATA_ROWS - 1 - (pastEightMiBIndex + 1);
  assert.ok(paddingRows > 0, "8 MiB 之后需要有可填充的数据行");
  const perRow = Math.floor(delta / paddingRows);
  const remainder = delta % paddingRows;
  for (let row = pastEightMiBIndex + 1; row < DATA_ROWS - 1; row += 1) {
    const extra = perRow + (row - (pastEightMiBIndex + 1) < remainder ? 1 : 0);
    if (extra > 0) values[row] += "x".repeat(extra);
  }

  text = renderLines(values);
  starts = lineStarts(text);
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lineCount = starts.length;

  assert.equal(totalBytes, TARGET_BYTES, "生成文件必须精确命中 10174816 字节");
  assert.equal(lineCount, TARGET_LINES, "生成文件必须命中 399194 行");
  assert.doesNotThrow(() => JSON.parse(text), "生成内容必须是合法 JSON");

  const boundaryLineStart = starts[boundaryIndex + 1];
  const boundaryLineEnd = starts[boundaryIndex + 2] - 1; // 不含换行
  assert.ok(boundaryLineStart < LEGACY_BLOCK_STEP);
  assert.ok(boundaryLineEnd > LEGACY_BLOCK_STEP, "边界行必须真正横跨 262140");

  return {
    text,
    totalBytes,
    lineCount,
    boundary: {
      dataIndex: boundaryIndex,
      /** Monaco / 用户可见的 1-based 行号（首行 `[` 是第 1 行）。 */
      lineNumber: boundaryIndex + 2,
      lineStart: boundaryLineStart,
      lineEnd: boundaryLineEnd,
      leftStart,
      rightStart,
    },
    pastEightMiB: {
      offset: text.indexOf(TOKENS.pastEightMiB),
      lineNumber: pastEightMiBIndex + 2,
    },
    tail: {
      offset: text.indexOf(TOKENS.tail),
      lineNumber: DATA_ROWS + 1,
    },
    dataRows: DATA_ROWS,
  };
}
