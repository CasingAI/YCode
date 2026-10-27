import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSkillsService } from "../src/skills/skillsService.js";

// services 侧 SKILL.md `title` 解析契约（docs/specs/skill-title.md）：
// UI 技能列表数据源必须与 adapters 侧语义一致：空/超长按未声明，回退 name 展示。

function writeWorkspaceSkill(workspacePath: string, dirName: string, frontmatter: string): void {
  const skillDir = join(workspacePath, ".zcode", "skills", dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Body\n`);
}

test("list 返回 frontmatter title", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "skills-title-ws-"));
  writeWorkspaceSkill(
    workspacePath,
    "titled",
    "name: titled\ntitle: My Friendly Tool\ndescription: demo",
  );
  const service = createSkillsService();
  const result = await service.list({ workspacePath });
  const skill = result.skills.find((item) => item.name === "titled");
  assert.ok(skill);
  assert.equal(skill.title, "My Friendly Tool");
});

test("超长或空 title 回退为不设置字段", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "skills-title-fallback-ws-"));
  writeWorkspaceSkill(
    workspacePath,
    "long-title",
    `name: long-title\ntitle: ${"x".repeat(81)}\ndescription: demo`,
  );
  writeWorkspaceSkill(workspacePath, "blank", "name: blank\ntitle: '  '\ndescription: demo");
  writeWorkspaceSkill(workspacePath, "untitled", "name: untitled\ndescription: demo");
  const service = createSkillsService();
  const result = await service.list({ workspacePath });
  assert.equal(result.skills.find((item) => item.name === "long-title")?.title, undefined);
  assert.equal(result.skills.find((item) => item.name === "blank")?.title, undefined);
  assert.equal(result.skills.find((item) => item.name === "untitled")?.title, undefined);
});
