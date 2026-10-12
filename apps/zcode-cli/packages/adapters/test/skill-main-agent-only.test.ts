import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeSkillAdapter } from "../src/skills/index.js";

// 主 Agent 专属声明（frontmatter main_agent_only）的解析契约：只认 true
//（大小写不敏感）；其余值视为未设置。见 docs/specs/language-art-skill.md。

function writeSkill(
  root: string,
  dirName: string,
  frontmatter: string,
): { rootPath: string; skillPath: string } {
  const skillDir = join(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, `---\n${frontmatter}\n---\n\n# Body\n`);
  return { rootPath: root, skillPath };
}

test("main_agent_only: true 解析为专属标记", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-main-only-"));
  writeSkill(root, "language-art", "name: language-art\ndescription: 中文手册\nmain_agent_only: true");
  const adapter = new NodeSkillAdapter();
  const outcome = await adapter.discoverSkills({
    workingDirectory: root,
    roots: [{ path: root, scope: "system", source: "plugin", priority: 1 }],
  });
  assert.equal(outcome.skills.length, 1);
  assert.equal(outcome.skills[0]?.mainAgentOnly, true);
});

test("main_agent_only 缺席或非 true 时不标记专属", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-main-only-off-"));
  writeSkill(root, "plain", "name: plain\ndescription: 普通技能");
  writeSkill(root, "off", "name: off\ndescription: 关闭\nmain_agent_only: false");
  writeSkill(root, "weird", "name: weird\ndescription: 怪值\nmain_agent_only: yes");
  const adapter = new NodeSkillAdapter();
  const outcome = await adapter.discoverSkills({
    workingDirectory: root,
    roots: [{ path: root, scope: "system", source: "plugin", priority: 1 }],
  });
  assert.equal(outcome.skills.length, 3);
  for (const skill of outcome.skills) {
    assert.equal(skill.mainAgentOnly, undefined);
  }
});

test("大小写 TRUE 同样识别为主 Agent 专属", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-main-only-case-"));
  writeSkill(root, "upper", "name: upper\ndescription: 大写\nmain_agent_only: TRUE");
  const adapter = new NodeSkillAdapter();
  const outcome = await adapter.discoverSkills({
    workingDirectory: root,
    roots: [{ path: root, scope: "system", source: "plugin", priority: 1 }],
  });
  assert.equal(outcome.skills[0]?.mainAgentOnly, true);
});
