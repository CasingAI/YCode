import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { SkillToolCallBlock } from "../src/ToolCallBlocks/renderers/skill.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

const LEGACY_ARGS_SENTINEL = "legacy-skill-args-sentinel";
const SKILL_OUTPUT_SENTINEL = "loaded-skill-output-sentinel";

function renderSkillCard(forceOpen: boolean): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: forceOpen ? "skill-args-expanded" : "skill-args-collapsed",
        toolName: "Skill",
        kind: "skill",
        title: "debug-mode",
        input: {
          skill: "debug-mode",
          args: LEGACY_ARGS_SENTINEL,
        },
        output: SKILL_OUTPUT_SENTINEL,
        status: "completed",
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
    childToolList: null,
    canToggle: true,
    forceOpen,
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SkillToolCallBlock, context),
    ),
  );
}

function assertLegacyArgsAreHidden(markup: string): void {
  assert.match(markup, /debug-mode/);
  assert.equal(markup.includes(LEGACY_ARGS_SENTINEL), false);
  assert.equal(markup.includes("参数"), false);
}

test("collapsed Skill card hides legacy args from the summary", () => {
  assertLegacyArgsAreHidden(renderSkillCard(false));
});

test("expanded Skill card hides legacy args from the details", () => {
  const markup = renderSkillCard(true);

  assertLegacyArgsAreHidden(markup);
  assert.equal(markup.includes(SKILL_OUTPUT_SENTINEL), true);
});
