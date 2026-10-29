import assert from "node:assert/strict";
import test from "node:test";
import {
  CoreErrorType,
  type ActiveWebSearchProvider,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchPort,
} from "@zcode/contracts";
import { resolveWebSearchToolExposed } from "../src/runtime/methods/config.js";
import { webSearchToolEntry } from "../src/tool/handlers/websearch.js";
import { formatWebSearchModelContent } from "../src/tool/handlers/websearch-results.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

// spec: docs/specs/web-search-provider-capability.md
// WebSearch 门控与执行路由只认 WebSearchPort：端口缺席或解析不出激活搜索源即不暴露、
// 调用报可恢复 ConfigurationError；有激活源时整个 input 透传端口执行。

const PROVIDER: ActiveWebSearchProvider = {
  providerId: "personal:ds-main",
  templateId: "deepseek",
  endpoint: {
    kind: "rest",
    endpoint: "https://api.deepseek.com/v1/tools/search",
    defaultPriority: 3,
    billing: "per-call",
  },
  apiKey: "sk-test",
};

function fakePort(
  active: ActiveWebSearchProvider | undefined,
  searchImpl?: WebSearchPort["search"],
): WebSearchPort & { searchCalls: unknown[] } {
  const searchCalls: unknown[] = [];
  return {
    searchCalls,
    resolveActiveProvider: () => active,
    search: (async (input: WebSearchInput, provider: ActiveWebSearchProvider, options: unknown) => {
      searchCalls.push({ input, provider, options });
      const output: WebSearchOutput = {
        query: input.query,
        results: [],
        sources: [],
        durationMs: 1,
      };
      return output;
    }) as WebSearchPort["search"],
  };
}

function contextWith(port?: WebSearchPort): ToolExecutionContext {
  return {
    toolCallId: "call-1",
    traceId: "trace-1",
    abortSignal: new AbortController().signal,
    webSearchPort: port,
  } as ToolExecutionContext;
}

test("WebSearch 门控：端口缺席或解析不出激活源时不暴露，与模型无关", () => {
  assert.equal(resolveWebSearchToolExposed(undefined), false, "端口未注入即 fail-closed");
  assert.equal(resolveWebSearchToolExposed(fakePort(undefined)), false, "无激活搜索源不暴露");
  assert.equal(resolveWebSearchToolExposed(fakePort(PROVIDER)), true, "解析出激活源即暴露");
});

test("WebSearch handler：透传 input 与 abortSignal 到端口并原样返回结果", async () => {
  const port = fakePort(PROVIDER);
  const input: WebSearchInput = { query: "zcode release notes" };
  const output = await webSearchToolEntry.handler!(input, contextWith(port));
  assert.equal(port.searchCalls.length, 1);
  const call = port.searchCalls[0] as {
    input: WebSearchInput;
    provider: ActiveWebSearchProvider;
    options: { abortSignal?: AbortSignal };
  };
  assert.deepEqual(call.input, input);
  assert.equal(call.provider, PROVIDER, "handler 必须用端口解析出的激活源执行");
  assert.ok(call.options.abortSignal, "上下文 abortSignal 要透传给端口");
  assert.equal(output.query, input.query);
});

test("WebSearch handler：无端口或无激活源时抛可恢复 ConfigurationError", async () => {
  const input: WebSearchInput = { query: "anything" };
  for (const port of [undefined, fakePort(undefined)]) {
    await assert.rejects(
      webSearchToolEntry.handler!(input, contextWith(port)),
      (error: unknown) => {
        assert.equal((error as { type?: CoreErrorType }).type, CoreErrorType.ConfigurationError);
        assert.equal((error as { recoverable?: boolean }).recoverable, true);
        return true;
      },
    );
  }
});

test("WebSearch 模型内容：展示结果链接与摘要，按小写 url 去重", () => {
  const content = formatWebSearchModelContent({
    query: "zcode",
    results: [
      { title: "Docs", url: "https://a.example/1", pageAge: "2026-10-01", snippet: "first snippet" },
      { url: "https://A.example/1", snippet: "duplicate case" },
      { title: "Other", url: "https://b.example/2" },
    ],
    sources: [],
    durationMs: 5,
  });
  assert.match(content, /\[Docs\]\(https:\/\/a\.example\/1\) \(2026-10-01\)/u);
  assert.match(content, /first snippet/u);
  assert.doesNotMatch(content, /duplicate case/u, "仅大小写不同的重复结果不应重复展示");
  assert.match(content, /\[Other\]\(https:\/\/b\.example\/2\)/u);
  assert.match(content, /REMINDER:/u);
});
