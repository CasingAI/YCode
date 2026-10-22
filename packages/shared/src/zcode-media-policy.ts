/** ZCode 接受单个 video 输入的全局原始字节上限。 */
export const VIDEO_INPUT_MAX_BYTES = 30 * 1024 * 1024;

/**
 * 图片进入模型前的预算。客户端预压缩与 CLI 兜底压缩必须使用同一组数值，
 * 否则「客户端压过」的产物会被 CLI 判定为仍超预算而重跑一遍压缩。
 * 见 docs/specs/client-image-precompression.md。
 */
export const IMAGE_MODEL_MAX_BASE64_BYTES = 5 * 1024 * 1024;
/** 压缩后原始字节上限，取 base64 上限的 3/4（base64 膨胀 4/3）。 */
export const IMAGE_MODEL_MAX_RAW_BYTES = Math.floor((IMAGE_MODEL_MAX_BASE64_BYTES * 3) / 4);
/** 压缩后最长边的像素上限。 */
export const IMAGE_MODEL_MAX_DIMENSION = 2000;

export const MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE =
  "MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE";
export const MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE =
  "MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE";

export const MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE =
  "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE";
