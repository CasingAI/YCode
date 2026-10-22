export class OversizedInlineAttachmentError extends Error {
  readonly filename: string;
  readonly maxSizeBytes: number;
  readonly sizeBytes: number;

  constructor(
    name: string,
    message: string,
    options: { filename: string; maxSizeBytes: number; sizeBytes: number },
  ) {
    super(message);
    this.name = name;
    this.filename = options.filename;
    this.maxSizeBytes = options.maxSizeBytes;
    this.sizeBytes = options.sizeBytes;
  }
}

export class OversizedInlineImageAttachmentError extends OversizedInlineAttachmentError {
  constructor(options: { filename: string; maxSizeBytes: number; sizeBytes: number }) {
    super("OversizedInlineImageAttachmentError", "oversized-inline-image-attachment", options);
  }
}

/**
 * 图片解码后的像素总数超限。与体积超限同等处理：直接拒绝使用这张图片。
 * 见 docs/specs/client-image-precompression.md。
 */
export class OversizedInlineImageDimensionsError extends Error {
  readonly filename: string;
  readonly height: number;
  readonly maxPixels: number;
  readonly width: number;

  constructor(options: { filename: string; height: number; maxPixels: number; width: number }) {
    super("oversized-inline-image-dimensions");
    this.name = "OversizedInlineImageDimensionsError";
    this.filename = options.filename;
    this.width = options.width;
    this.height = options.height;
    this.maxPixels = options.maxPixels;
  }
}

export class OversizedInlineVideoAttachmentError extends OversizedInlineAttachmentError {
  constructor(options: { filename: string; maxSizeBytes: number; sizeBytes: number }) {
    super("OversizedInlineVideoAttachmentError", "oversized-inline-video-attachment", options);
  }
}

export class OversizedInlinePdfAttachmentError extends OversizedInlineAttachmentError {
  constructor(options: { filename: string; maxSizeBytes: number; sizeBytes: number }) {
    super("OversizedInlinePdfAttachmentError", "oversized-inline-pdf-attachment", options);
  }
}

export class OversizedInlineFileAttachmentError extends OversizedInlineAttachmentError {
  constructor(options: { filename: string; maxSizeBytes: number; sizeBytes: number }) {
    super("OversizedInlineFileAttachmentError", "oversized-inline-file-attachment", options);
  }
}

export class MissingInlinePdfContentError extends Error {
  readonly filename: string;
  readonly sizeBytes: number;

  constructor(options: { filename: string; sizeBytes: number }) {
    super("missing-inline-pdf-content");
    this.name = "MissingInlinePdfContentError";
    this.filename = options.filename;
    this.sizeBytes = options.sizeBytes;
  }
}

export class MissingInlineImageContentError extends Error {
  readonly filename: string;
  readonly sizeBytes: number;

  constructor(options: { filename: string; sizeBytes: number }) {
    super("missing-inline-image-content");
    this.name = "MissingInlineImageContentError";
    this.filename = options.filename;
    this.sizeBytes = options.sizeBytes;
  }
}
