# 图片附件客户端预压缩

> 状态：已实现
> 关联：`docs/specs/web-composer-attachments.md`、`docs/specs/plugin-cli-proxy-binary.md`（无关）

## 背景

图片附件的发送卡顿长期存在：局域网内上传一张手机照片，从「按下发送」到「会话真正开始」要等 5~20 秒。根因不在网络，而在 CLI 侧的纯 JS 图像压缩。

附件处理实际分成两个阶段：

| 阶段 | 触发时机 | 做什么 | 实测耗时（4000×3000 手机照片，局域网） |
|---|---|---|---|
| 阶段 A：上传 | 选图后立刻 | 分块上传，CLI 只做 sha256 校验和落盘，**不碰图像库** | 1~2 秒 |
| 阶段 B：压缩 | **按下发送后** | CLI 用 Jimp（纯 JS）解码、缩放、反复试不同 JPEG quality 直到塞进模型预算 | **5~20 秒** |

阶段 B 慢的三个已确认原因（见 `apps/zcode-cli/packages/adapters/src/image/jimp-compression.ts`）：

1. **重复编码阶梯**。同一张图在多个位置被用相同参数反复编码，参数与结果必然相同，纯浪费 4~24 次编码。
2. **首个候选用 quality=100**。`@jimp/js-jpeg` 默认 `quality = 100`，而模型预算只有 3.75MiB，首个候选注定超限。
3. **纯 JS 编码器**。`jpeg-js@0.4.4` 逐字节写进 JS 数组，DCT 也是朴素实现。实测同条件（2000×1500 含纹理，q80）Node 侧 205ms / 861KB，Chromium 原生 canvas 35ms / 472KB，**差 5.9 倍**。

「有时卡有时不卡」也能解释：候选搜索按 JPEG quality 从高到低试探，**试几次取决于照片内容复杂度**，与网络无关。

## 产品规则

### 压缩发生在客户端，CLI 降级为兜底

压缩前移到客户端：用户选图之后、真正上传之前，用浏览器原生 canvas 压一次。CLI 侧的 Jimp 管线**保留**，降级为兜底，覆盖这些场景：

- 老客户端（没有预压缩能力）
- CLI 独立调用、tool 直接产出的图片
- 远端 workspace（浏览器在本地、CLI 在远端）
- 客户端压缩后仍超模型预算

### 预算常量

客户端与 CLI 必须使用同一组数值，保证「客户端压过」和「CLI 压过」产物同规格。常量的唯一权威定义在 `packages/shared/src/zcode-media-policy.ts`：

| 常量 | 值 | 语义 |
|---|---|---|
| `IMAGE_MODEL_MAX_BASE64_BYTES` | 5 MiB | base64 编码后的字节上限 |
| `IMAGE_MODEL_MAX_RAW_BYTES` | 3.75 MiB | 压缩后原始字节上限（= base64 上限的 3/4） |
| `IMAGE_MODEL_MAX_DIMENSION` | 2000 px | 最长边像素上限 |

CLI 侧 `apps/zcode-cli/packages/contracts/src/tools/read.ts` 与 `apps/zcode-cli/packages/core/src/runtime/types.ts` 的同名常量改为引用 shared 的定义，数值不变。

另有两个客户端侧的独立上限：

| 常量 | 值 | 位置 | 语义 |
|---|---|---|---|
| `INLINE_IMAGE_ATTACHMENT_MAX_BYTES` | 20 MiB | `packages/ui/src/lib/chatAttachments.ts` | 附件文件字节上限 |
| `CLIENT_IMAGE_MAX_PIXELS` | 6000 万 | `packages/ui/src/lib/imagePrecompression.ts` | 解码后像素总数上限 |

### 超限一律拒绝，不降级

| 检查 | 阈值 | 动作 |
|---|---|---|
| 文件字节 | > 20 MiB | 拒绝，`OversizedInlineImageAttachmentError`（既有） |
| 解码后像素 | > 6000 万 | 拒绝，`OversizedInlineImageDimensionsError`（新增） |
| 压缩后体积 | > 3.75 MiB | 降 quality 重试；仍超则降尺寸重试；再不行交 CLI 兜底 |

像素上限 6000 万的依据：对应约 240MB 的 RGBA 位图，是可以接受的解码上限；同时相对 2000px 的输出目标仍有充足余量，正常手机照片（主流 12MP~48MP）都在范围内。

字节超限与像素超限的处理完全一致：**直接拒绝使用这张图片**，不静默降级、不截断。

### 客户端压缩算法

```
File
 ├─ 1. file.size > 20MiB            → 拒绝（不读字节）
 ├─ 2. 读前 64KB 解析尺寸            → 文件头解析，零解码
 │    JPEG: SOFn 段 / PNG: IHDR 偏移 16,20 / WebP: VP8X 偏移 24
 ├─ 3. width*height > 6000万         → 拒绝
 ├─ 4. 尺寸与体积都已在预算内        → 直接传原图，不重编码
 ├─ 5. createImageBitmap 解码        → 浏览器自动应用 EXIF Orientation
 ├─ 6. drawImage 缩放到最长边 2000px（只缩不放）
 ├─ 7. canvas 编码                   → PNG 源先试 PNG，失败再退 JPEG
 └─ 8. 体积超预算                    → 降 quality 重试；仍超则降尺寸重试
```

关键约束：

- **必须显式校验 `blob.type`**。浏览器对不支持的编码格式会**静默回退 PNG**，而 PNG 忽略 quality 参数，体积反而更大。校验失败视为编码失败。
- **必须用 `OffscreenCanvas`**（不可用时才退回元素 `<canvas>`）。元素 `<canvas>` 在尺寸超限时 `toBlob` 返回 null、`getImageData` 返回全 0 像素，**静默产出全黑图**；`OffscreenCanvas` 抛 `IndexSizeError`，是明确的失败信号。
- **尺寸探测走文件头解析而不是解码**。探测只读前 64KB，避免为了判断大小先把整张图解码进内存。
- **EXIF 方向由浏览器处理**。`createImageBitmap` 默认按 Orientation 旋转，canvas 重新编码后 EXIF 标记自然消失，CLI 侧不再重复旋转。
- **能力缺失时不压缩**。没有 `OffscreenCanvas` / `createImageBitmap` / `canvas` 时，原图交给 CLI 兜底，不报错。
- **PNG 源优先保留 PNG**。PNG 在能装进预算时保留原格式（保留 alpha 通道，截图场景不劣化）；装不下才转 JPEG。JPEG/WebP 源统一输出 JPEG。

### CLI 侧修正

Jimp 管线保留，但删掉已确认的浪费：

1. **删重复阶梯**。`findFormatPreservingCandidate(image, "image/jpeg")` 与 `findJpegQualityCandidate(image)` 参数完全相同、结果必然相同，合并为一次 JPEG 质量搜索。另外两处同源重复也一并去掉：原尺寸已在预算内时，`boundedImage` 与原图逐像素相同，对它再跑一次阶梯纯属重复；缩放档候选已经用第一档质量编过同一张图，阶梯里那一档也跳过。**删除后输出字节与改前逐字节一致**（首个命中候选不变）。
2. **首档 q100 → q80**。q80 的产物恒小于 q100，q100 被完全支配，删掉注定失败的首次编码。

## 状态所有者

| 状态 | 所有者 |
|---|---|
| 附件原始字节、尺寸探测结果、预压缩产物 | 客户端 `packages/ui/src/lib/imagePrecompression.ts` |
| 附件序列化（base64 / localPath） | 客户端 `packages/ui/src/lib/chatAttachments.ts` |
| 上传事务与进度 | 客户端 `packages/ui/src/v4/composer/useComposerAttachments.ts` + `packages/ui/src/v4/attachmentUploadTransaction.ts` |
| 附件落盘与摘要校验 | CLI `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/attachment-refs.ts` |
| 模型预算兜底压缩 | CLI `apps/zcode-cli/packages/adapters/src/image/jimp-compression.ts` |

**上传阶段只落盘原始字节**，压缩不再发生在上传路径里。

## 接口

### `packages/ui/src/lib/imagePrecompression.ts`

```ts
export const CLIENT_IMAGE_MAX_PIXELS = 60_000_000;

export interface ImageDimensions { height: number; width: number }

export type ImagePrecompressionPlan =
  | { kind: "compress" }
  | { kind: "passthrough"; reason: "unknown-dimensions" | "within-budget" }
  | { kind: "reject"; height: number; width: number };

export function probeImageDimensions(bytes: Uint8Array): ImageDimensions | undefined;
export function planImagePrecompression(input: {
  dimensions: ImageDimensions | undefined;
  sizeBytes: number;
}): ImagePrecompressionPlan;

export interface PrecompressedImage {
  blob: Blob;
  compressed: boolean;
  filename: string;
  height: number;
  mimeType: string;
  sizeBytes: number;
  width: number;
}

export async function precompressImage(file: File): Promise<PrecompressedImage | undefined>;
```

`precompressImage` 返回 `undefined` 表示「没有压缩，按原图走」，调用方继续使用原始字节。

### `packages/ui/src/lib/chatAttachmentErrors.ts`

- 基类 `OversizedInlineAttachmentError` 导出（原来未导出，子类无法被统一识别）。
- 新增 `OversizedInlineImageDimensionsError`，携带 `filename` / `width` / `height` / `maxPixels`。

### `packages/ui/src/lib/chatAttachments.ts`

`serializeChatComposerAttachment` 的 image 分支在读 base64 **之前**接入预压缩：

- 预压缩产出存在 → 用压缩后的字节、mimeType、文件名、体积
- 预压缩产出不存在（能力缺失 / 已在预算内 / 格式无法识别）→ 沿用原图
- 像素超限 → 抛 `OversizedInlineImageDimensionsError`
- 压缩后仍超 20 MiB → 抛既有 `OversizedInlineImageAttachmentError`

## 验收场景

1. 手机（Web）上传 6MB 照片：上传分块从 16 块降到约 2 块；按下发送时**无压缩等待**，命中 CLI 早退分支。
2. 桌面端拖拽 6MB 照片：图片带 `localPath`，走零上传路径（上传层优先用 `localPath`，字节不走网络），因此**客户端预压缩不参与**；该路径的耗时由 CLI 侧兜底压缩负责，删重复阶梯后编码次数从最多约 39 次降到个位数。
3. 超过 20MiB 的文件：选图后立即拒绝，给出本地化文案，**不自动重试**。
4. 像素超过 6000 万的图：选图后立即拒绝，给出本地化文案，**不自动重试**。
5. CLI 删重复阶梯后，同一输入的压缩输出字节与改前逐字节一致（首个命中候选不变；只有「首个候选用 q100」这一处是刻意的产物变化）。
6. 客户端没有 canvas 能力时，预压缩静默跳过，图片仍可正常发送。
