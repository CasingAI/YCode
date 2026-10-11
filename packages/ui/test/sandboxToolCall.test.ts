import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getZCodeToolFamilyForName } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { resolveToolCallIdentity } from "../src/lib/toolIdentity.js";
import { resolveToolCallRenderer } from "../src/ToolCallBlocks/resolveRenderer.js";
import {
  SandboxToolCallBlock,
  formatSandboxDescriptionPreview,
  readSandboxDescriptionFromInput,
  readSandboxSourceFromInput,
  sandboxSummaryText,
  type SandboxSummaryFormat,
} from "../src/ToolCallBlocks/renderers/sandbox.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

// Sandbox 计算卡：折叠行只显示一句话说明，后台态显示已在后台+ID，不进 shell family。
// 卡面规则见 docs/specs/sandbox-system-tool.md「聊天工具卡」。

const zhFormat: SandboxSummaryFormat = (descriptor, values) => {
  const messages: Record<string, string> = {
    "chat.toolCall.sandbox.backgrounded": "已在后台",
    "chat.toolCall.sandbox.backgroundedWithId": "已在后台 · {taskId}",
  };
  const template = messages[descriptor.id] ?? descriptor.id;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    values && key in values ? String(values[key]) : `{${key}}`,
  );
};

function buildContext(overrides: {
  toolName: string;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
  forceOpen?: boolean;
  status?: "completed" | "failed" | "in_progress";
  errorText?: string;
}): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: `sandbox-${overrides.toolName}`,
        toolName: overrides.toolName,
        kind: "",
        input: overrides.input ?? {},
        output: overrides.output,
        raw: overrides.raw,
        status: overrides.status ?? "completed",
      },
    },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: true,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "已完成",
    errorText: overrides.errorText,
    childToolList: null,
    canToggle: true,
    forceOpen: overrides.forceOpen ?? false,
  };
}

function renderCard(
  component: (context: ToolCallBlockRenderContext) => React.ReactNode,
  overrides: {
    toolName: string;
    input?: unknown;
    output?: unknown;
    raw?: unknown;
    forceOpen?: boolean;
    status?: "completed" | "failed" | "in_progress";
    errorText?: string;
  },
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(component, buildContext(overrides)),
    ),
  );
}

test("折叠行只显示一句话说明（input.description）", () => {
  assert.equal(
    sandboxSummaryText({ kind: "sandbox", status: "success" }, "算一下斐波那契", zhFormat),
    "算一下斐波那契",
  );
});

test("说明超 60 字符截断", () => {
  assert.equal(formatSandboxDescriptionPreview("说".repeat(100)).length < 100, true);
  assert.equal(readSandboxDescriptionFromInput({ description: "  " }), undefined);
  assert.equal(readSandboxDescriptionFromInput({}), undefined);
});

test("后台态显示已在后台+ID，不把代码当摘要", () => {
  assert.equal(
    sandboxSummaryText(
      { kind: "sandbox", status: "backgrounded", backgroundTaskId: "sandbox_abc" },
      "return 1+1;",
      zhFormat,
    ),
    "已在后台 · sandbox_abc",
  );
  assert.equal(
    sandboxSummaryText({ kind: "sandbox", status: "backgrounded" }, "算一下", zhFormat),
    "已在后台",
  );
});

test("折叠 Sandbox 卡：折叠行是说明，源码不出折叠行", () => {
  const markup = renderCard(SandboxToolCallBlock, {
    toolName: "Sandbox",
    input: { description: "算一下斐波那契", code: "return 1+1;" },
    output: "<return>\n2\n</return>",
    raw: { display: { kind: "sandbox", status: "success" } },
  });
  assert.match(markup, /沙盒/);
  assert.match(markup, /算一下斐波那契/);
  assert.equal(markup.includes("return 1+1;"), false);
});

test("折叠 Sandbox 卡：display 缺席时同一输入字段兜底", () => {
  const markup = renderCard(SandboxToolCallBlock, {
    toolName: "Sandbox",
    input: { description: "算一下斐波那契", code: "return 1+1;" },
    output: "<return>\n2\n</return>",
  });
  assert.match(markup, /算一下斐波那契/);
  // 源码不出折叠行（只显示一句话说明）。
  assert.equal(markup.includes("return 1+1;"), false);
});

test("展开 Sandbox 卡：源码在输出之前只读展示，折叠行仍只有说明", () => {
  const markup = renderCard(SandboxToolCallBlock, {
    toolName: "Sandbox",
    input: { description: "算一下", code: "return 1+1;" },
    output: "<return>\n2\n</return>",
    raw: { display: { kind: "sandbox", status: "success" } },
    forceOpen: true,
  });
  // 源码出现且在输出之前（spec 展开态：源码/路径 + 输出）。
  const codeIndex = markup.indexOf("return 1+1;");
  assert.ok(codeIndex >= 0);
  assert.ok(codeIndex < markup.indexOf("2", codeIndex));
  // 路径形态同样展示。
  const pathMarkup = renderCard(SandboxToolCallBlock, {
    toolName: "Sandbox",
    input: { description: "跑文件", filePath: "scripts/job.js" },
    output: "<return>\nok\n</return>",
    raw: { display: { kind: "sandbox", status: "success" } },
    forceOpen: true,
  });
  assert.match(pathMarkup, /scripts\/job\.js/);
});

test("展开 Sandbox 卡：return 与 console 合进同一个代码块", () => {
  const markup = renderCard(SandboxToolCallBlock, {
    toolName: "Sandbox",
    input: { description: "算一下", code: "return 1+1;" },
    output: "<return>\n2\n</return>\n\n<console>\nhello\n</console>",
    raw: { display: { kind: "sandbox", status: "success" } },
    forceOpen: true,
  });
  // 同一个 pre 里同时出现 return 正文与 console 正文，且 return 在前。
  const preBlocks = [...markup.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
  const combined = preBlocks.find((block) => block.includes("2") && block.includes("hello"));
  assert.ok(combined !== undefined, "return 与 console 应在同一个代码块内");
  assert.ok(combined.indexOf("2") < combined.indexOf("hello"));
});

test("readSandboxSourceFromInput：code/filePath 二选一读取，空输入回 undefined", () => {
  assert.deepEqual(readSandboxSourceFromInput({ code: "return 1;" }), { code: "return 1;" });
  assert.deepEqual(readSandboxSourceFromInput({ filePath: "a.js" }), { filePath: "a.js" });
  assert.equal(readSandboxSourceFromInput({ description: "只有说明" }), undefined);
  assert.equal(readSandboxSourceFromInput({}), undefined);
});

test("后台 Sandbox 卡：折叠行是已在后台+ID", () => {
  const markup = renderCard(SandboxToolCallBlock, {
    toolName: "Sandbox",
    input: { description: "慢任务", code: "await sleep(9999);", runInBackground: true },
    output: "仍在跑",
    raw: { display: { kind: "sandbox", status: "backgrounded", backgroundTaskId: "sandbox_xyz" } },
  });
  assert.match(markup, /已在后台/);
  assert.match(markup, /sandbox_xyz/);
});

test("Sandbox 不进 shell family：跨端无 family，UI identity 不回 shell", () => {
  // 跨端 family 未登记（学 History 三工具）：getZCodeToolFamilyForName 回 null。
  assert.equal(getZCodeToolFamilyForName("Sandbox"), null);
  // UI identity：工具名直判无 family，kind 兜底也不认 sandbox 拼写，不进终端文案。
  const identity = resolveToolCallIdentity({ toolName: "Sandbox", kind: "", title: "" });
  assert.notEqual(identity.family, "shell");
});

test("展开 Sandbox 卡：首次调用输出只留正文，reminder 与信封都不进用户视图", () => {
  const markup = renderCard(SandboxToolCallBlock, {
    toolName: "Sandbox",
    input: { description: "算一下", code: "return 1+1;" },
    output:
      "<system-reminder>这是新沙盒实例：旧堆内存没了，LocalStorage 还在。</system-reminder>\n\n<return>\n2\n</return>\n\n<console>\nhello\n</console>",
    raw: { display: { kind: "sandbox", status: "success" } },
    forceOpen: true,
  });
  // 正文在。
  assert.match(markup, /2/);
  assert.match(markup, /hello/);
  // 模型信封不在用户视图：reminder 整块、新实例正文、return/console 原始标签都不渲染。
  assert.equal(markup.includes("system-reminder"), false);
  assert.equal(markup.includes("新沙盒实例"), false);
  assert.equal(markup.includes("&lt;return&gt;") || markup.includes("<return>"), false);
  assert.equal(markup.includes("&lt;console&gt;") || markup.includes("<console>"), false);
});

test("失败 Sandbox 卡：tooltip 剥 reminder，错误正文仍可见", () => {
  const markup = renderCard(SandboxToolCallBlock, {
    toolName: "Sandbox",
    input: { description: "跑一段错代码", code: "throw 1;" },
    output: "SyntaxError: bad",
    raw: { display: { kind: "sandbox", status: "failed" } },
    status: "failed",
    errorText:
      "SyntaxError: bad\n\n<system-reminder>这是新沙盒实例：旧堆内存没了，LocalStorage 还在。</system-reminder>",
    forceOpen: true,
  });
  assert.match(markup, /SyntaxError/);
  assert.equal(markup.includes("system-reminder"), false);
  assert.equal(markup.includes("新沙盒实例"), false);
});

test("resolveRenderer 按名分流到 Sandbox 卡", () => {
  const context = buildContext({
    toolName: "Sandbox",
    input: { description: "算一下", code: "return 1;" },
  });
  assert.equal(resolveToolCallRenderer(context), SandboxToolCallBlock);
});
