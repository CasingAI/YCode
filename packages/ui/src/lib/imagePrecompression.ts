import { IMAGE_MODEL_MAX_DIMENSION, IMAGE_MODEL_MAX_RAW_BYTES } from "@zcode/shared";
import { OversizedInlineImageDimensionsError } from "@/lib/chatAttachmentErrors.js";
import { probeImageDimensions, type ImageDimensions } from "@/lib/imageDimensionProbe.js";

export { probeImageDimensions, type ImageDimensions } from "@/lib/imageDimensionProbe.js";

/**
 * 客户端图片预压缩（见 docs/specs/client-image-precompression.md）。
 *
 * 压缩发生在选图之后、上传之前，用浏览器原生 canvas 完成；CLI 侧的 Jimp 管线
 * 降级为兜底（老客户端、tool 产出图、远端 workspace）。
 */

/**
 * 解码后允许的最大像素总数。对应约 240MB 的 RGBA 位图，是可以接受的解码上限；
 * 超过则直接拒绝使用这张图片，避免一张构造出来的图片把渲染进程拖垮。
 */
export const CLIENT_IMAGE_MAX_PIXELS = 60_000_000;

/** 尺寸探测只读文件头这么多字节：JPEG 的 SOF 段、PNG 的 IHDR、WebP 的 VP8 头都在开头。 */
const IMAGE_HEADER_PROBE_BYTES = 64 * 1024;

/** JPEG 质量阶梯。首选较高质量，体积超预算时逐档下降。 */
const JPEG_QUALITY_STEPS = [0.85, 0.72, 0.6] as const;

/** 质量降到最低仍然超预算时，按比例继续缩小尺寸。 */
const FALLBACK_SCALE_STEPS = [0.75, 0.5] as const;

const MIME_EXTENSION_BY_OUTPUT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/**
 * 目标输出格式是否支持 alpha 通道。
 * 不支持的格式（当前只有 JPEG）必须先铺白底，否则透明像素在转码后会变成黑块；
 * 支持的格式铺白底则会把原图的透明区域永久替换成白色，属于不可逆的内容修改。
 */
const OUTPUT_FORMAT_SUPPORTS_ALPHA = new Set(["image/png", "image/webp"]);

export type ImagePrecompressionPlan =
  | { kind: "compress" }
  | { kind: "passthrough"; reason: "unknown-dimensions" | "within-budget" }
  | { kind: "reject"; height: number; width: number };

export interface PrecompressedImage {
  blob: Blob;
  compressed: boolean;
  filename: string;
  height: number;
  mimeType: string;
  sizeBytes: number;
  width: number;
}

/**
 * 决定这张图要不要压缩：
 * - 像素超限 → 拒绝（与体积超限同等处理，不降级）
 * - 尺寸与体积都已在模型预算内 → 不压缩，原图直传，CLI 侧命中早退分支
 * - 其余 → 压缩
 */
export function planImagePrecompression(input: {
  dimensions: ImageDimensions | undefined;
  sizeBytes: number;
}): ImagePrecompressionPlan {
  const dimensions = input.dimensions;
  if (!dimensions) {
    return { kind: "passthrough", reason: "unknown-dimensions" };
  }
  if (dimensions.width * dimensions.height > CLIENT_IMAGE_MAX_PIXELS) {
    return {
      kind: "reject",
      height: dimensions.height,
      width: dimensions.width,
    };
  }
  if (
    dimensions.width <= IMAGE_MODEL_MAX_DIMENSION &&
    dimensions.height <= IMAGE_MODEL_MAX_DIMENSION &&
    input.sizeBytes <= IMAGE_MODEL_MAX_RAW_BYTES
  ) {
    return { kind: "passthrough", reason: "within-budget" };
  }
  return { kind: "compress" };
}

/**
 * 压缩图片。返回 undefined 表示「没有压缩，按原图走」：能力缺失、格式无法识别、
 * 或者原图已经在预算内。像素超限时抛错。
 */
export async function precompressImage(
  file: File,
  sourceMimeType?: string,
): Promise<PrecompressedImage | undefined> {
  const headerBytes = await readHeaderBytes(file);
  const dimensions = probeImageDimensions(headerBytes);
  const plan = planImagePrecompression({
    dimensions,
    sizeBytes: file.size,
  });

  if (plan.kind === "reject") {
    throw new OversizedInlineImageDimensionsError({
      filename: file.name,
      width: plan.width,
      height: plan.height,
      maxPixels: CLIENT_IMAGE_MAX_PIXELS,
    });
  }
  if (plan.kind === "passthrough") {
    return undefined;
  }
  if (!canCompressImages()) {
    return undefined;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await globalThis.createImageBitmap(file);
  } catch {
    // 浏览器解不了这个格式（例如 Chromium 不支持 HEIC），交给 CLI 兜底。
    return undefined;
  }

  try {
    if (bitmap.width * bitmap.height > CLIENT_IMAGE_MAX_PIXELS) {
      throw new OversizedInlineImageDimensionsError({
        filename: file.name,
        width: bitmap.width,
        height: bitmap.height,
        maxPixels: CLIENT_IMAGE_MAX_PIXELS,
      });
    }

    const target = fitWithinDimension(bitmap.width, bitmap.height);
    const sourceMime = (sourceMimeType || file.type).split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const encoded = await encodeWithinBudget(bitmap, target, sourceMime);

    if (!encoded || encoded.blob.size >= file.size) {
      return undefined;
    }
    return {
      blob: encoded.blob,
      compressed: true,
      filename: withExtensionForMime(file.name, encoded.mimeType),
      height: encoded.height,
      mimeType: encoded.mimeType,
      sizeBytes: encoded.blob.size,
      width: encoded.width,
    };
  } finally {
    bitmap.close?.();
  }
}

interface EncodedImage {
  blob: Blob;
  height: number;
  mimeType: string;
  width: number;
}

/**
 * 按阶梯编码，直到体积落进模型预算：PNG 源先试 PNG（保留 alpha 通道），
 * 装不下再转 JPEG；JPEG/WebP 源统一输出 JPEG。
 */
async function encodeWithinBudget(
  bitmap: ImageBitmap,
  target: { height: number; width: number },
  sourceMime: string,
): Promise<EncodedImage | undefined> {
  let best: EncodedImage | undefined;

  if (sourceMime === "image/png") {
    const png = await encodeBitmap(bitmap, target.width, target.height, "image/png");
    if (png) {
      if (png.size <= IMAGE_MODEL_MAX_RAW_BYTES) {
        return { blob: png, height: target.height, mimeType: "image/png", width: target.width };
      }
      best = { blob: png, height: target.height, mimeType: "image/png", width: target.width };
    }
  }

  for (const quality of JPEG_QUALITY_STEPS) {
    const blob = await encodeBitmap(bitmap, target.width, target.height, "image/jpeg", quality);
    if (!blob) continue;
    const candidate: EncodedImage = {
      blob,
      height: target.height,
      mimeType: "image/jpeg",
      width: target.width,
    };
    if (blob.size <= IMAGE_MODEL_MAX_RAW_BYTES) {
      return candidate;
    }
    if (!best || blob.size < best.blob.size) {
      best = candidate;
    }
  }

  for (const scale of FALLBACK_SCALE_STEPS) {
    const width = Math.max(1, Math.round(target.width * scale));
    const height = Math.max(1, Math.round(target.height * scale));
    for (const quality of [0.72, 0.6]) {
      const blob = await encodeBitmap(bitmap, width, height, "image/jpeg", quality);
      if (!blob) continue;
      const candidate: EncodedImage = {
        blob,
        height,
        mimeType: "image/jpeg",
        width,
      };
      if (blob.size <= IMAGE_MODEL_MAX_RAW_BYTES) {
        return candidate;
      }
      if (!best || blob.size < best.blob.size) {
        best = candidate;
      }
    }
  }

  // 仍然装不下：交 CLI 兜底，但用我们压出来的最小产物，别把原图再传一遍。
  return best;
}

function fitWithinDimension(width: number, height: number): { height: number; width: number } {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= IMAGE_MODEL_MAX_DIMENSION) {
    return { height, width };
  }
  const scale = IMAGE_MODEL_MAX_DIMENSION / longestEdge;
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

function canCompressImages(): boolean {
  if (typeof globalThis.createImageBitmap !== "function") {
    return false;
  }
  return hasCanvasSupport();
}

function hasCanvasSupport(): boolean {
  if (typeof globalThis.OffscreenCanvas !== "undefined") {
    return true;
  }
  return typeof globalThis.document !== "undefined";
}

async function encodeBitmap(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  mimeType: string,
  quality?: number,
): Promise<Blob | undefined> {
  const canvas = createCanvas(width, height);
  if (!canvas) {
    return undefined;
  }
  const context = canvas.context;
  if (!context) {
    return undefined;
  }
  // 只有目标格式不支持 alpha 时才铺白底：JPEG 没有 alpha 通道，直接绘制会让透明
  // 像素在转码后变成黑块。PNG / WebP 保留 alpha，铺底会毁掉原图的透明区域。
  if (!OUTPUT_FORMAT_SUPPORTS_ALPHA.has(mimeType)) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.toBlob(mimeType, quality);
  // 浏览器对不支持的编码格式会静默回退 PNG，必须显式校验，否则会拿到一份
  // 忽略 quality、体积反而更大的 PNG。
  if (!blob || blob.type !== mimeType) {
    return undefined;
  }
  return blob;
}

/** canvas 2D 上下文的最小结构：元素 canvas 与 OffscreenCanvas 的上下文类型并不互相兼容。 */
interface Canvas2DContextLike {
  drawImage: (source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number) => void;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  fillStyle: unknown;
}

interface CanvasHandle {
  context: Canvas2DContextLike;
  toBlob: (mimeType: string, quality?: number) => Promise<Blob | null>;
}

function createCanvas(width: number, height: number): CanvasHandle | undefined {
  if (typeof globalThis.OffscreenCanvas !== "undefined") {
    const canvas = new globalThis.OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    return {
      context,
      toBlob: async (mimeType, quality) =>
        canvas.convertToBlob(
          quality === undefined ? { type: mimeType } : { type: mimeType, quality },
        ),
    };
  }
  if (typeof globalThis.document === "undefined") {
    return undefined;
  }
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return undefined;
  }
  return {
    context,
    toBlob: (mimeType, quality) =>
      new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), mimeType, quality);
      }),
  };
}

async function readHeaderBytes(file: File): Promise<Uint8Array> {
  const header = file.slice(0, IMAGE_HEADER_PROBE_BYTES);
  const buffer = await header.arrayBuffer();
  return new Uint8Array(buffer);
}

function withExtensionForMime(filename: string, mimeType: string): string {
  const extension = MIME_EXTENSION_BY_OUTPUT[mimeType];
  if (!extension) {
    return filename;
  }
  const dotIndex = filename.lastIndexOf(".");
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  if (base.toLowerCase().endsWith(extension)) {
    return filename;
  }
  return `${base}${extension}`;
}
