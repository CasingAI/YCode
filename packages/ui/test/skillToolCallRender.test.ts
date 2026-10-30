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
  kindLabelOverride?: string,
  toolTitle = "Skill",
): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId,
        toolName: "Skill",
        kind: "skill",
        title: toolTitle,
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
    ...(kindLabelOverride ? { kindLabelOverride } : {}),
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SkillToolCallBlock, context),
    ),
  );
}

const EMPTY_AUTHORITATIVE_CATALOG = buildSkillDisplayNameCatalog([], "zh-CN");

function assertLegacyArgsAreHidden(markup: string): void {
  assert.match(markup, /debug-mode/);
  assert.equal(markup.includes(LEGACY_ARGS_SENTINEL), false);
  assert.equal(markup.includes("参数"), false);
}

test("collapsed Skill card hides legacy args from the summary", () => {
  // 已完成目录（空表）是 authoritative miss，主标题按规范回退原始 ref。
  assertLegacyArgsAreHidden(
    renderSkillCard(false, "debug-mode", "skill-args-collapsed", EMPTY_AUTHORITATIVE_CATALOG),
  );
});

test("expanded Skill card hides legacy args from the details", () => {
  const markup = renderSkillCard(
    true,
    "debug-mode",
    "skill-args-expanded",
    EMPTY_AUTHORITATIVE_CATALOG,
  );

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

test("冷首帧（目录未就绪）折叠卡片不暴露原始 ref，就绪后直接显示友好名", () => {
  // 目录未就绪时主标题为空：只保留类别标签与状态，不出现 raw → 友好名的跳变。
  const pending = renderSkillCard(false, "team:team", "skill-title-pending");
  assert.equal(pending.includes("team:team"), false);
  assert.equal(pending.includes("技能"), true);

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
  const ready = renderSkillCard(false, "team:team", "skill-title-ready", catalog);
  assert.equal(ready.includes("Team 派工手册"), true);
  assert.equal(ready.includes("team:team"), false);
});

test("目录未就绪时原始 ref 即使出现在 toolCall.title 也不进入折叠摘要", () => {
  // 悬停提示与主标题同源，避免通过 title 属性提前泄露机器标识。
  const markup = renderSkillCard(
    false,
    "team:team",
    "skill-title-tooltip",
    undefined,
    undefined,
    "team:team",
  );
  assert.equal(markup.includes("team:team"), false);
});

test("请求失败或只读视图（查找表 undefined）折叠卡片用中性占位，展开详情保留 raw", () => {
  const collapsed = renderSkillCard(false, "team:team", "skill-title-unavailable");
  assert.equal(collapsed.includes("team:team"), false);

  const expanded = renderSkillCard(true, "team:team", "skill-title-unavailable-expanded");
  assert.equal(expanded.includes("team:team"), true);
});

test("只有 authoritative 空目录未命中时折叠卡片回退原始 ref", () => {
  assert.equal(
    renderSkillCard(
      false,
      "unknown:skill",
      "skill-title-miss",
      EMPTY_AUTHORITATIVE_CATALOG,
    ).includes("unknown:skill"),
    true,
  );
  assert.equal(
    renderSkillCard(false, "team:team", "skill-title-empty", EMPTY_AUTHORITATIVE_CATALOG).includes(
      "team:team",
    ),
    true,
  );
});

test("权限确认窗复用同一 renderer 的就绪语义，不先暴露原始 ref", () => {
  // PermissionDialog 的 context 没有查找表时与只读视图一致：折叠态中性，展开态保留 raw。
  const collapsed = renderSkillCard(
    false,
    "team:team",
    "skill-permission-pending",
    undefined,
    "等待批准",
  );
  assert.equal(collapsed.includes("team:team"), false);
  assert.equal(collapsed.includes("等待批准"), true);

  const expanded = renderSkillCard(
    true,
    "team:team",
    "skill-permission-pending-expanded",
    undefined,
    "等待批准",
  );
  assert.equal(expanded.includes("team:team"), true);
});
