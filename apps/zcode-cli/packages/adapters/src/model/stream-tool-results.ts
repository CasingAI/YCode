import type { ModelToolCall, ModelToolResult } from "@zcode/contracts";
import { normalizeToolResults } from "./runner-normalization.js";
import type { AiSdkGenerateTextResult, AiSdkStreamTextResult } from "./runner-runtime.js";

export async function resolveStreamToolResults(
  result: AiSdkStreamTextResult,
  toolCalls?: ModelToolCall[],
): Promise<ModelToolResult[] | undefined> {
  const toolResults = await result.toolResults;
  return normalizeToolResults({ toolResults } as unknown as AiSdkGenerateTextResult, toolCalls);
}
