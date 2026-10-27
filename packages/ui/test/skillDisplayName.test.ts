import assert from "node:assert/strict";
import test from "node:test";
import type { SkillSummary } from "@zcode/shared";
import {
  buildSkillDisplayNameCatalog,
  resolveSkillDisplayName,
  resolveSkillListLabel,
} from "../src/lib/skillDisplayName.js";

// skill-title.md 的展示名解析契约：
// 内置本地化标题 > frontmatter title > 原始输入；未命中回退原始输入且不报错。

function makeSkill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: "glm:plugin:demo:hash",
    name: "demo",
    description: "demo skill",
    body: "",
    path: "/plugins/demo/skills/demo/SKILL.md",
    scope: "plugin",
    enabled: true,
    ...overrides,
  };
}

test("内置插件技能在 zh-CN 下优先显示本地化标题", () => {
  const catalog = buildSkillDisplayNameCatalog(
    [
      makeSkill({
        name: "team",
        pluginName: "team",
        path: "/zcode-plugins-official/team/1.0.0/skills/team/SKILL.md",
      }),
    ],
    "zh-CN",
  );
  assert.equal(resolveSkillDisplayName("team:team", catalog), "Team 派工手册");
  assert.equal(resolveSkillDisplayName("team", catalog), "Team 派工手册");
});

test("内置插件技能在 en-US 下显示英文内置标题", () => {
  const catalog = buildSkillDisplayNameCatalog(
    [
      makeSkill({
        name: "team",
        pluginName: "team",
        path: "/zcode-plugins-official/team/1.0.0/skills/team/SKILL.md",
      }),
    ],
    "en-US",
  );
  assert.equal(resolveSkillDisplayName("team:team", catalog), "Team dispatch handbook");
});

test("非内置技能回退 frontmatter title", () => {
  const catalog = buildSkillDisplayNameCatalog(
    [
      makeSkill({
        name: "my-tool",
        title: "My Friendly Tool",
        pluginName: "community",
        path: "/community-plugin/skills/my-tool/SKILL.md",
      }),
    ],
    "zh-CN",
  );
  assert.equal(resolveSkillDisplayName("community:my-tool", catalog), "My Friendly Tool");
  const skill = makeSkill({
    name: "my-tool",
    title: "My Friendly Tool",
    pluginName: "community",
    path: "/community-plugin/skills/my-tool/SKILL.md",
  });
  assert.equal(resolveSkillListLabel(skill, "zh-CN"), "My Friendly Tool");
});

test("无 title 的技能回退原始标识与 name", () => {
  const catalog = buildSkillDisplayNameCatalog([makeSkill({ name: "plain" })], "zh-CN");
  assert.equal(resolveSkillDisplayName("plain", catalog), "plain");
  assert.equal(resolveSkillDisplayName("misc:plain", catalog), "misc:plain");
});

test("目录未就绪或未命中时回退原始输入", () => {
  assert.equal(resolveSkillDisplayName("team:team", undefined), "team:team");
  const catalog = buildSkillDisplayNameCatalog([], "zh-CN");
  assert.equal(resolveSkillDisplayName("team:team", catalog), "team:team");
});

test("市场官方插件技能（源不在本仓库）经由内置 i18n 表补齐标题", () => {
  const catalog = buildSkillDisplayNameCatalog(
    [
      makeSkill({
        name: "docx",
        pluginName: "documents",
        path: "/zcode-plugins-official/documents/0.2.1/skills/docx/SKILL.md",
      }),
      makeSkill({
        name: "computer-use",
        pluginName: "computer-use",
        path: "/zcode-plugins-official/computer-use/0.6.5/skills/computer-use/SKILL.md",
      }),
      makeSkill({
        name: "diagnosing-mcp",
        pluginName: "zcode-guide",
        path: "/zcode-plugins-official/zcode-guide/0.3.0/skills/diagnosing-mcp/SKILL.md",
      }),
      makeSkill({
        name: "brainstorming",
        pluginName: "superpowers",
        path: "/zcode-plugins-official/superpowers/1.0.0/skills/brainstorming/SKILL.md",
      }),
    ],
    "zh-CN",
  );
  assert.equal(resolveSkillDisplayName("documents:docx", catalog), "Word 文档处理");
  assert.equal(resolveSkillDisplayName("computer-use:computer-use", catalog), "电脑操控");
  assert.equal(resolveSkillDisplayName("zcode-guide:diagnosing-mcp", catalog), "MCP 诊断");
  assert.equal(resolveSkillDisplayName("superpowers:brainstorming", catalog), "头脑风暴");
});

test("官方插件名的同名 workspace 技能不受内置标题影响", () => {
  const catalog = buildSkillDisplayNameCatalog(
    [
      makeSkill({
        name: "docx",
        title: "My Doc Helper",
        scope: "workspace",
        pluginName: undefined,
        path: "/ws/.zcode/skills/docx/SKILL.md",
      }),
    ],
    "zh-CN",
  );
  assert.equal(resolveSkillDisplayName("docx", catalog), "My Doc Helper");
});

test("查找表收录小写形态，容忍大小写差异的裸名输入", () => {
  const catalog = buildSkillDisplayNameCatalog([makeSkill({ name: "Visual-Output" })], "zh-CN");
  assert.equal(resolveSkillDisplayName("visual-output", catalog), "Visual-Output");
});
