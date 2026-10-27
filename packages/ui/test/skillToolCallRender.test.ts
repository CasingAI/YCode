import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { buildSkillDisplayNameCatalog } from "../src/lib/skillDisplayName.js";
import { SkillToolCallBlock } from "../src/ToolCallBlocks/renderers/skill.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

const LEGACY_ARGS_SENTINEL = "legacy-skill-args-sentinel";
const SKILL_OUTPUT_SENTINEL = "loaded-skill-output-sentinel";

function renderSkillCard(
  forceOpen: boolean,
  skillInput = "debug-mode",
  toolId = forceOpen ? "skill-args-expanded" : "skill-args-collapsed",
  skillDisplayNameByRef?: ReadonlyMap<string, string>,
): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId,
        toolName: "Skill",
        kind: "skill",
        title: skillInput,
        input: {
          skill: skillInput,
          args: LEGACY_ARGS_SENTINEL,
        },
        output: SKILL_OUTPUT_SENTINEL,
        status: "completed",
      },
    },
    skillDisplayNameByRef,
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

test("查找表命中时折叠卡片显示展示名，原始 ID 保留在展开详情", () => {
  const catalog = buildSkillDisplayNameCatalog(
    [
      {
        name: "team",
        description: "Team-mode dispatch handbook.",
        path: "C:/zcode-plugins-official/team/1.0.0/skills/team/SKILL.md",
        scope: "plugin",
        pluginName: "team",
      },
    ],
    "zh-CN",
  );
  const collapsed = renderSkillCard(false, "team:team", "skill-title-collapsed", catalog);
  assert.equal(collapsed.includes("Team 派工手册"), true);
  assert.equal(collapsed.includes(LEGACY_ARGS_SENTINEL), false);

  const expanded = renderSkillCard(true, "team:team", "skill-title-expanded", catalog);
  // 展开详情仍展示原始 plugin:skill 标识，用户可以对回机器名（skill-title.md）。
  assert.equal(expanded.includes("team:team"), true);
  assert.equal(expanded.includes("Team 派工手册"), true);
});

test("查找表缺省或未命中时回退原始输入", () => {
  assert.equal(renderSkillCard(false, "unknown:skill", "skill-title-miss").includes("unknown:skill"), true);
  const emptyCatalog = buildSkillDisplayNameCatalog([], "zh-CN");
  assert.equal(
    renderSkillCard(false, "team:team", "skill-title-empty", emptyCatalog).includes("team:team"),
    true,
  );
});
