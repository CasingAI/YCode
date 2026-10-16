import type { ModelToolResult, ToolArtifactStorePort } from "../deps.js";
import type { MessageId, SessionId, TraceContext } from "../deps.js";

const GENERATED_IMAGE_MARKDOWN = /!\[([^\]]*)\]\(attachment:generated-image\)/g;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export async function persistProviderGeneratedImages(input: {
  artifactStore?: ToolArtifactStorePort;
  assistantMessageId: MessageId;
  content: string;
  results?: ModelToolResult[];
  toolCallIds?: readonly string[];
  sessionId: SessionId;
  traceContext: TraceContext;
}): Promise<string> {
  const imageUrisByToolCallId = new Map<string, string[]>();
  const resultsById = new Map((input.results ?? []).map((result) => [result.id, result]));
  const orderedResults = (input.toolCallIds ?? []).length
    ? (input.toolCallIds ?? []).flatMap((id) => {
        const result = resultsById.get(id);
        return result ? [result] : [];
      })
    : (input.results ?? []);
  for (const result of orderedResults) {
    if (result.providerExecuted !== true || result.name !== "image_generation") continue;
    const artifactUris: string[] = [];
    for (const [imageIndex, dataUrl] of imageDataUrls(result.output).entries()) {
      if (!input.artifactStore) continue;
      try {
        const artifact = await input.artifactStore.writeToolResultArtifact({
          content: dataUrl,
          contentType: "text/plain",
          retention: "session",
          sessionId: input.sessionId,
          toolCallId: `${result.id}-image-${imageIndex + 1}`,
          toolName: result.name,
          trace: input.traceContext,
        });
        artifactUris.push(artifact.uri);
      } catch {
        // 图片附件是正文的增强内容；artifact 写入失败时由下方占位提示降级，不中断回合。
      }
    }
    imageUrisByToolCallId.set(result.id, artifactUris);
  }

  const orderedToolCallIds = (input.toolCallIds ?? []).length
    ? input.toolCallIds!
    : orderedResults.map((result) => result.id);
  let currentToolCallIndex = 0;
  let imageIndexForToolCall = 0;
  return input.content.replace(GENERATED_IMAGE_MARKDOWN, (_match, alt: string) => {
    while (currentToolCallIndex < orderedToolCallIds.length) {
      const imageUris = imageUrisByToolCallId.get(orderedToolCallIds[currentToolCallIndex]!) ?? [];
      if (imageIndexForToolCall < imageUris.length) {
        const uri = imageUris[imageIndexForToolCall++];
        return uri ? `![${alt}](${uri})` : `![${alt}] 图片不可用`;
      }
      currentToolCallIndex += 1;
      imageIndexForToolCall = 0;
    }
    return `![${alt}] 图片不可用`;
  });
}

function imageDataUrls(output: unknown): string[] {
  const candidates: string[] = [];
  const record = asRecord(output);
  const rawResult = record?.result;
  const result = asRecord(rawResult);
  const image = asRecord(result?.image);
  const raw =
    typeof rawResult === "string"
      ? rawResult
      : typeof result?.image === "string"
        ? result.image
        : undefined;
  if (raw && isValidBase64Png(raw)) candidates.push(`data:image/png;base64,${raw}`);
  if (image && typeof image.data === "string" && typeof image.mimeType === "string") {
    const url = image.data.startsWith("data:")
      ? image.data
      : `data:${image.mimeType};base64,${image.data}`;
    if (isValidImageDataUrl(url)) candidates.push(url);
  }
  const direct = typeof rawResult === "string" ? rawResult : undefined;
  if (direct?.startsWith("data:") && isValidImageDataUrl(direct)) candidates.push(direct);
  return candidates;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isValidImageDataUrl(value: string): boolean {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== match[2]) return false;
  return match[1] !== "image/png" || hasPngSignature(bytes);
}

function isValidBase64Png(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 8 && bytes.toString("base64") === value && hasPngSignature(bytes);
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}
