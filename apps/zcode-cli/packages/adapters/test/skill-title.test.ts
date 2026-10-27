import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeSkillAdapter } from "../src/skills/index.js";

// frontmatter 可选 `title` 的解析契约（docs/specs/skill-title.md）：
// 仅作 UI 展示元数据；空串或超过 80 字符按未声明处理；不得影响 safeToAutoLoad。

function writeSkill(root: string, dirName: string, frontmatter: string): string {
  const skillDir = join(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, `---\n${frontmatter}\n---\n\n# Body\n`);
  return skillPath;
}

async function discoverSingle(root: string) {
  const adapter = new NodeSkillAdapter();
  const outcome = await adapter.discoverSkills({
    workingDirectory: root,
    roots: [{ path: root, scope: "system", source: "plugin", priority: 1 }],
  });
  return outcome;
}

test("title 解析为展示元数据且不影响 safeToAutoLoad", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-title-"));
  writeSkill(root, "titled", "name: titled\ntitle: My Friendly Tool\ndescription: demo");
  const outcome = await discoverSingle(root);
  const skill = outcome.skills.find((item) => item.name === "titled");
  assert.ok(skill);
  assert.equal(skill.title, "My Friendly Tool");
  // title 属于安全 frontmatter 键，不应把技能降级为不可自动加载。
  assert.equal(skill.safeToAutoLoad, true);
});

test("超长 title 按未声明处理，技能仍正常加载", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-title-long-"));
  const longTitle = "x".repeat(81);
  writeSkill(root, "long-title", `name: long-title\ntitle: ${longTitle}\ndescription: demo`);
  const outcome = await discoverSingle(root);
  const skill = outcome.skills.find((item) => item.name === "long-title");
  assert.ok(skill);
  assert.equal(skill.title, undefined);
  assert.equal(skill.safeToAutoLoad, true);
});

test("缺省或空 title 不设置字段", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-title-empty-"));
  writeSkill(root, "untitled", "name: untitled\ndescription: demo");
  writeSkill(root, "blank", "name: blank\ntitle: \"  \"\ndescription: demo");
  const outcome = await discoverSingle(root);
  assert.equal(outcome.skills.find((item) => item.name === "untitled")?.title, undefined);
  assert.equal(outcome.skills.find((item) => item.name === "blank")?.title, undefined);
});
