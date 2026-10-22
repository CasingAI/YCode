import assert from "node:assert/strict";
import test from "node:test";
import { Jimp, JimpMime, ResizeStrategy } from "jimp";
import { prepareJimpImageForModel } from "../src/image/jimp-compression.js";

// CLI 侧兜底压缩的两个硬保证（见 docs/specs/client-image-precompression.md）：
// 1. 首个 JPEG 候选用 q80 而不是 jimp 默认的 q100——q100 相对 3.75MiB 的模型预算
//    几乎必然超限，那次编码纯属浪费。
// 2. 同一张图不再被用相同参数反复编码：删掉重复阶梯后，命中的第一个候选不变，
//    产物字节与改前逐字节一致。

const MAX_BASE64_BYTES = 5 * 1024 * 1024;
const MAX_RAW_BYTES = Math.floor((MAX_BASE64_BYTES * 3) / 4);
const MAX_DIMENSION = 2000;

interface EncodeCall {
  mime: string;
  quality: unknown;
}

function withEncodeRecorder<T>(run: (calls: EncodeCall[]) => Promise<T>): Promise<T> {
  const calls: EncodeCall[] = [];
  const originalGetBuffer = Jimp.prototype.getBuffer;
  Jimp.prototype.getBuffer = async function patched(
    this: Jimp,
    mime: unknown,
    options?: unknown,
  ) {
    calls.push({
      mime: String(mime),
      quality: (options as { quality?: unknown } | undefined)?.quality,
    });
    return originalGetBuffer.call(this, mime as never, options as never);
  };
  return run(calls).finally(() => {
    Jimp.prototype.getBuffer = originalGetBuffer;
  });
}

/** 确定性噪声图：内容熵高，JPEG 压不下来，用来逼出「首个候选超限」这条路径。 */
async function createNoiseJpeg(width: number, height: number, quality: number): Promise<Buffer> {
  const image = new Jimp({ width, height, color: 0x000000ff });
  let seed = 987654321;
  for (let index = 0; index < image.bitmap.data.length; index += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const base = seed & 0xff;
    image.bitmap.data[index] = base;
    image.bitmap.data[index + 1] = (base >> 3) & 0xff;
    image.bitmap.data[index + 2] = (base >> 5) & 0xff;
    image.bitmap.data[index + 3] = 0xff;
  }
  return image.getBuffer(JimpMime.jpeg, { quality });
}

/** 独立复算「缩放到 2000px 后的 q80 编码」，用来比对产物字节是否逐字节一致。 */
async function referenceBoundedJpegQ80(input: Buffer): Promise<Buffer> {
  const decoded = await Jimp.read(input);
  const bounded = decoded.clone();
  bounded.scaleToFit({
    h: MAX_DIMENSION,
    mode: ResizeStrategy.BICUBIC,
    w: MAX_DIMENSION,
  });
  return bounded.getBuffer(JimpMime.jpeg, { quality: 80 });
}

test("超出尺寸上限的图片：首个候选就是 q80，产物与缩放后 q80 编码逐字节一致", async () => {
  const input = await createNoiseJpeg(2100, 1500, 90);

  const { result, calls } = await withEncodeRecorder(async (recorded) => {
    const prepared = await prepareJimpImageForModel({
      data: input,
      mediaType: "image/jpeg",
      maxBase64Bytes: MAX_BASE64_BYTES,
      maxDimension: MAX_DIMENSION,
      maxRawBytes: MAX_RAW_BYTES,
    });
    return { calls: [...recorded], result: prepared };
  });

  // 只编码一次：q100 首档被删掉之后，缩放档的 q80 直接命中。
  assert.equal(calls.length, 1, `不该重复编码，实际 ${calls.length} 次：${JSON.stringify(calls)}`);
  assert.equal(calls[0]?.mime, JimpMime.jpeg);
  assert.equal(calls[0]?.quality, 80, "首个候选必须是 q80，不能是 jimp 默认的 q100");

  assert.equal(result.mediaType, "image/jpeg");
  assert.ok((result.width ?? 0) <= MAX_DIMENSION);
  assert.ok((result.height ?? 0) <= MAX_DIMENSION);
  assert.ok(result.data.byteLength <= MAX_RAW_BYTES, "产物必须落进模型预算");
  assert.ok(result.data.byteLength < input.byteLength);

  const reference = await referenceBoundedJpegQ80(input);
  assert.equal(result.data.byteLength, reference.byteLength);
  assert.ok(result.data.equals(reference), "产物必须与缩放后 q80 编码逐字节一致");
});

test("尺寸与体积都在预算内：原样返回，一次编码都不做", async () => {
  const input = await createNoiseJpeg(320, 240, 60);

  const { result, calls } = await withEncodeRecorder(async (recorded) => {
    const prepared = await prepareJimpImageForModel({
      data: input,
      mediaType: "image/jpeg",
      maxBase64Bytes: MAX_BASE64_BYTES,
      maxDimension: MAX_DIMENSION,
      maxRawBytes: MAX_RAW_BYTES,
    });
    return { calls: [...recorded], result: prepared };
  });

  assert.equal(calls.length, 0, "已经在预算内就不该再编码");
  assert.equal(result.strategy, "original");
  assert.equal(result.data.byteLength, input.byteLength);
  assert.equal(result.resized, false);
  assert.equal(result.compressed, false);
});

test("尺寸在预算内但体积超限：走原尺寸质量阶梯，只编码一次", async () => {
  const input = await createNoiseJpeg(1900, 1400, 100);

  const { result, calls } = await withEncodeRecorder(async (recorded) => {
    const prepared = await prepareJimpImageForModel({
      data: input,
      mediaType: "image/jpeg",
      maxBase64Bytes: MAX_BASE64_BYTES,
      maxDimension: MAX_DIMENSION,
      maxRawBytes: MAX_RAW_BYTES,
    });
    return { calls: [...recorded], result: prepared };
  });

  assert.ok(input.byteLength > MAX_RAW_BYTES, "这个输入必须先超限才有意义");
  assert.equal(calls.length, 1, `不该重复编码，实际 ${calls.length} 次：${JSON.stringify(calls)}`);
  assert.equal(calls[0]?.quality, 80);
  assert.ok(result.data.byteLength <= MAX_RAW_BYTES);
  assert.equal(result.width, 1900);
  assert.equal(result.height, 1400);
});
