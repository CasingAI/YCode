import assert from "node:assert/strict";
import test from "node:test";
import { OversizedInlineImageDimensionsError } from "../src/lib/chatAttachmentErrors.js";
import {
  CLIENT_IMAGE_MAX_PIXELS,
  planImagePrecompression,
  precompressImage,
  probeImageDimensions,
} from "../src/lib/imagePrecompression.js";

// 客户端图片预压缩（见 docs/specs/client-image-precompression.md）：
// 尺寸探测必须零解码，超限一律拒绝，编码产物必须落进模型预算。

function pngHeaderBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegHeaderBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

function webpHeaderBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  bytes.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff], 24);
  bytes.set([(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff], 27);
  return bytes;
}

function gifHeaderBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  bytes.set([width & 0xff, (width >> 8) & 0xff], 6);
  bytes.set([height & 0xff, (height >> 8) & 0xff], 8);
  return bytes;
}

function paddedFile(header: Uint8Array, filename: string, type: string, totalBytes: number): File {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(header, 0);
  return new File([bytes], filename, { type });
}

test("文件头解析：JPEG / PNG / WebP / GIF 都能拿到尺寸", () => {
  assert.deepEqual(probeImageDimensions(jpegHeaderBytes(4000, 3000)), {
    width: 4000,
    height: 3000,
  });
  assert.deepEqual(probeImageDimensions(pngHeaderBytes(1920, 1080)), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(probeImageDimensions(webpHeaderBytes(2560, 1440)), {
    width: 2560,
    height: 1440,
  });
  assert.deepEqual(probeImageDimensions(gifHeaderBytes(640, 480)), {
    width: 640,
    height: 480,
  });
});

test("文件头解析：无法识别的内容返回 undefined，不猜尺寸", () => {
  assert.equal(probeImageDimensions(new Uint8Array(0)), undefined);
  assert.equal(probeImageDimensions(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), undefined);
  assert.equal(probeImageDimensions(pngHeaderBytes(0, 0)), undefined);
});

test("压缩计划：像素超限一律拒绝", () => {
  const plan = planImagePrecompression({
    dimensions: { width: 10000, height: 10000 },
    sizeBytes: 1024,
  });
  assert.equal(plan.kind, "reject");
  assert.equal(CLIENT_IMAGE_MAX_PIXELS, 60_000_000);
});

test("压缩计划：尺寸与体积都在预算内就不压，尺寸未知也按原图走", () => {
  assert.deepEqual(
    planImagePrecompression({ dimensions: { width: 800, height: 600 }, sizeBytes: 1024 }),
    { kind: "passthrough", reason: "within-budget" },
  );
  assert.deepEqual(planImagePrecompression({ dimensions: undefined, sizeBytes: 1024 }), {
    kind: "passthrough",
    reason: "unknown-dimensions",
  });
  assert.deepEqual(
    planImagePrecompression({ dimensions: { width: 4000, height: 3000 }, sizeBytes: 1024 }),
    { kind: "compress" },
  );
});

test("像素超限：直接拒绝使用这张图片", async () => {
  const file = paddedFile(pngHeaderBytes(10000, 10000), "huge.png", "image/png", 4 * 1024 * 1024);
  await assert.rejects(
    precompressImage(file),
    (error: unknown) =>
      error instanceof OversizedInlineImageDimensionsError &&
      error.filename === "huge.png" &&
      error.width === 10000 &&
      error.height === 10000 &&
      error.maxPixels === CLIENT_IMAGE_MAX_PIXELS,
  );
});

test("没有 canvas 能力时不压缩，按原图走", async () => {
  const file = paddedFile(pngHeaderBytes(4000, 3000), "photo.png", "image/png", 4 * 1024 * 1024);
  const previousBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width: 4000,
    height: 3000,
    close() {},
  });
  try {
    assert.equal(await precompressImage(file), undefined);
  } finally {
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = previousBitmap;
  }
});

interface FakeCanvasState {
  created: { height: number; width: number }[];
  encode: (options: { quality?: number; type: string }) => Blob | null;
  fills: { fillStyle: unknown; height: number; width: number; x: number; y: number }[];
}

interface FakeCanvasContext {
  drawImage: () => void;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  fillStyle: unknown;
}

function installFakeCanvas(state: FakeCanvasState, bitmap: { height: number; width: number }) {
  const globals = globalThis as {
    createImageBitmap?: unknown;
    OffscreenCanvas?: unknown;
  };
  globals.createImageBitmap = async () => ({ ...bitmap, close() {} });
  globals.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      state.created.push({ height, width });
    }

    getContext(): FakeCanvasContext {
      const context: FakeCanvasContext = {
        drawImage() {},
        fillRect(x, y, width, height) {
          state.fills.push({ fillStyle: context.fillStyle, height, width, x, y });
        },
        fillStyle: "",
      };
      return context;
    }

    async convertToBlob(options: { quality?: number; type: string }) {
      return state.encode(options);
    }
  };
  return () => {
    globals.createImageBitmap = undefined;
    globals.OffscreenCanvas = undefined;
  };
}

test("压缩产出：缩到最长边 2000px，PNG 源保留 PNG，体积落进模型预算", async () => {
  const state: FakeCanvasState = {
    created: [],
    fills: [],
    encode: (options) => new Blob([new Uint8Array(1000)], { type: options.type }),
  };
  const restore = installFakeCanvas(state, { width: 4000, height: 3000 });
  try {
    const file = paddedFile(pngHeaderBytes(4000, 3000), "photo.png", "image/png", 4 * 1024 * 1024);
    const result = await precompressImage(file);
    assert.ok(result);
    assert.equal(result.compressed, true);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.filename, "photo.png");
    assert.equal(result.width, 2000);
    assert.equal(result.height, 1500);
    assert.equal(result.sizeBytes, 1000);
    assert.deepEqual(state.created[0], { width: 2000, height: 1500 });
  } finally {
    restore();
  }
});

test("压缩产出：JPEG 源统一输出 JPEG，文件名后缀跟着改", async () => {
  const state: FakeCanvasState = {
    created: [],
    fills: [],
    encode: (options) => new Blob([new Uint8Array(1000)], { type: options.type }),
  };
  const restore = installFakeCanvas(state, { width: 4000, height: 3000 });
  try {
    const file = paddedFile(
      jpegHeaderBytes(4000, 3000),
      "photo.jpeg",
      "image/jpeg",
      4 * 1024 * 1024,
    );
    const result = await precompressImage(file);
    assert.ok(result);
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.filename, "photo.jpg");
    assert.equal(result.sizeBytes, 1000);
  } finally {
    restore();
  }
});

test("编码格式被浏览器静默改写时不采信产物，按原图走", async () => {
  const state: FakeCanvasState = {
    created: [],
    fills: [],
    // 浏览器对不支持的格式会静默回退 PNG，type 对不上就不能用。
    encode: () => new Blob([new Uint8Array(1000)], { type: "image/png" }),
  };
  const restore = installFakeCanvas(state, { width: 4000, height: 3000 });
  try {
    const file = paddedFile(
      jpegHeaderBytes(4000, 3000),
      "photo.jpeg",
      "image/jpeg",
      4 * 1024 * 1024,
    );
    assert.equal(await precompressImage(file), undefined);
  } finally {
    restore();
  }
});

test("PNG 源保留 PNG 时不铺白底，透明通道不被替换", async () => {
  const state: FakeCanvasState = {
    created: [],
    fills: [],
    encode: (options) => new Blob([new Uint8Array(1000)], { type: options.type }),
  };
  const restore = installFakeCanvas(state, { width: 4000, height: 3000 });
  try {
    const file = paddedFile(pngHeaderBytes(4000, 3000), "shot.png", "image/png", 4 * 1024 * 1024);
    const result = await precompressImage(file);
    assert.ok(result);
    assert.equal(result.mimeType, "image/png");
    // PNG 保留 alpha 通道：铺白底会把原图透明区域永久替换成白色。
    assert.deepEqual(state.fills, []);
    assert.equal(state.created.length, 1);
  } finally {
    restore();
  }
});

test("PNG 装不下预算转 JPEG 时才铺白底，透明区域不会变黑块", async () => {
  const state: FakeCanvasState = {
    created: [],
    fills: [],
    encode: (options) =>
      new Blob([new Uint8Array(options.type === "image/png" ? 5 * 1024 * 1024 : 1000)], {
        type: options.type,
      }),
  };
  const restore = installFakeCanvas(state, { width: 4000, height: 3000 });
  try {
    const file = paddedFile(pngHeaderBytes(4000, 3000), "shot.png", "image/png", 4 * 1024 * 1024);
    const result = await precompressImage(file);
    assert.ok(result);
    assert.equal(result.mimeType, "image/jpeg");
    // PNG 那一轮不铺底，只有 JPEG 那一轮铺白底。
    assert.equal(state.fills.length, 1);
    assert.equal(state.fills[0]?.fillStyle, "#ffffff");
  } finally {
    restore();
  }
});
