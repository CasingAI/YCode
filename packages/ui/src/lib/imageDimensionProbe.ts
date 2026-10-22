/**
 * 图片文件头尺寸探测（见 docs/specs/client-image-precompression.md）。
 *
 * 只读文件开头若干字节，不解码像素：为了判断「要不要压缩」「能不能用」，没必要
 * 先把整张图解码进内存。识别 JPEG / PNG / WebP / GIF，识别不了就返回 undefined，
 * 由调用方按原图处理。
 */

export interface ImageDimensions {
  height: number;
  width: number;
}

export function probeImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  return (
    probeJpegDimensions(bytes) ??
    probePngDimensions(bytes) ??
    probeWebpDimensions(bytes) ??
    probeGifDimensions(bytes)
  );
}

function probeJpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // 填充字节之后可能有多个 0xff。
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无负载的独立标记。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) {
      // 图像数据开始，后面没有尺寸信息了。
      return undefined;
    }
    const segmentLength = (bytes[offset + 2] ?? 0) * 256 + (bytes[offset + 3] ?? 0);
    if (segmentLength < 2) {
      return undefined;
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const height = (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0);
      const width = (bytes[offset + 7] ?? 0) * 256 + (bytes[offset + 8] ?? 0);
      if (width <= 0 || height <= 0) {
        return undefined;
      }
      return { height, width };
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function probePngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) {
    return undefined;
  }
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) {
      return undefined;
    }
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return undefined;
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { height, width };
}

function probeWebpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) {
    return undefined;
  }
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return undefined;
  }
  const fourcc = String.fromCharCode(
    bytes[12] ?? 0,
    bytes[13] ?? 0,
    bytes[14] ?? 0,
    bytes[15] ?? 0,
  );
  if (fourcc === "VP8X") {
    const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
    const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
    if (width <= 0 || height <= 0) {
      return undefined;
    }
    return { height, width };
  }
  if (fourcc === "VP8 ") {
    const width = ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff;
    const height = ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff;
    if (width <= 0 || height <= 0) {
      return undefined;
    }
    return { height, width };
  }
  return undefined;
}

function probeGifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) {
    return undefined;
  }
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) {
    return undefined;
  }
  const width = (bytes[6] ?? 0) + ((bytes[7] ?? 0) << 8);
  const height = (bytes[8] ?? 0) + ((bytes[9] ?? 0) << 8);
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { height, width };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}
