import {
  WebSearchOutputSchema,
  modelMessageContentToText,
  type WebSearchResultItem,
} from "@zcode/contracts";

const MAX_MODEL_RESULTS = 20;
// 摘要截断：模型只需要判断相关性，长正文属于 WebFetch 职责。
const MAX_SNIPPET_CHARS = 300;

export function formatWebSearchModelContent(output: unknown): string {
  const parsed = WebSearchOutputSchema.safeParse(output);
  if (!parsed.success) return modelMessageContentToText(JSON.stringify(output) ?? "");

  const data = parsed.data;
  const lines = [`Web search results for query: "${data.query}"`, ""];

  if (data.summary) {
    lines.push("Summary:", data.summary, "");
  }

  const results = dedupeResultsByUrl(data.results).slice(0, MAX_MODEL_RESULTS);
  if (results.length > 0) {
    lines.push("Results:");
    for (const result of results) {
      const meta = result.pageAge ? ` (${result.pageAge})` : "";
      lines.push(`- [${result.title ?? result.url}](${result.url})${meta}`);
      if (result.snippet) lines.push(`  ${truncateSnippet(result.snippet)}`);
    }
  } else {
    lines.push("Results:", "- No results found.");
  }

  lines.push(
    "",
    "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
  );
  return lines.join("\n").trim();
}

// 供应商可能对同一 url 返回仅大小写不同的两行；模型内容按小写 url 去重。
function dedupeResultsByUrl(results: WebSearchResultItem[]): WebSearchResultItem[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function truncateSnippet(snippet: string): string {
  const collapsed = snippet.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_SNIPPET_CHARS
    ? `${collapsed.slice(0, MAX_SNIPPET_CHARS)}…`
    : collapsed;
}
