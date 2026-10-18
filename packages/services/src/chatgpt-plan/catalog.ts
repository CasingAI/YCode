import { CHATGPT_PLAN_API_ORIGIN, type ChatGPTPlanModel } from "@zcode/shared";
import type { ChatGPTRegistration } from "./store.js";
import { ChatGPTPlanError } from "./responses.js";

export async function listChatGPTPlanModels(
  fetchImpl: typeof fetch,
  account: ChatGPTRegistration,
): Promise<ChatGPTPlanModel[]> {
  if (!account.tokens?.scopes.includes("chatgpt.tokens.use.direct")) return [];
  const response = await fetchImpl(`${CHATGPT_PLAN_API_ORIGIN}/models`, {
    headers: { Authorization: `Bearer ${account.tokens.accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new ChatGPTPlanError(`models_http_${response.status}`);
  const body = (await response.json()) as {
    models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
  };
  if (!Array.isArray(body.models)) throw new ChatGPTPlanError("invalid_model_catalog");
  return body.models
    .filter((m) => m.visibility === "list")
    .map((m) => {
      if (
        typeof m.slug !== "string" ||
        !m.slug ||
        typeof m.display_name !== "string" ||
        !m.display_name
      )
        throw new ChatGPTPlanError("invalid_model_catalog");
      return { slug: m.slug, displayName: m.display_name };
    });
}
