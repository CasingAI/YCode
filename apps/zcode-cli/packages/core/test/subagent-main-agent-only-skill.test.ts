import assert from "node:assert/strict";
import test from "node:test";
import type {
  SkillContent,
  SkillLoadOutcome,
  SkillMetadata,
  SkillPort,
} from "@zcode/contracts";
import { resolveSubagentSkillPort } from "../src/runtime/methods/subagent.js";
import { createOfficialCuaPolicy } from "../src/subagent/computer-use-policy.js";

// main_agent_only 过滤语义的锁：子 Agent 的 FilteredSkillPort 对专属技能必须
// 清单不可见、显式加载同样拒绝（即使 profile 白名单写了该名）；主 Agent 路径
// （父 Port 本体）不受影响。见 docs/specs/language-art-skill.md「仅主 Agent 可见」。

function skill(overrides: Partial<SkillMetadata> & { name: string }): SkillMetadata {
  return {
    description: "test skill",
    path: `/tmp/skills/${overrides.name}/SKILL.md`,
    directory: `/tmp/skills/${overrides.name}`,
    rootPath: "/tmp/skills",
    scope: "user",
    source: "plugin",
    safeToAutoLoad: true,
    frontmatterKeys: ["name", "description"],
    ...overrides,
  };
}

const MAIN_ONLY = skill({
  name: "language-art",
  description: "语言的艺术",
  qualifiedName: "language-art:language-art",
  pluginName: "language-art",
  mainAgentOnly: true,
});
const ORDINARY = skill({ name: "plain", qualifiedName: "plain:plain", pluginName: "plain" });

function parentPort(skills: SkillMetadata[] = [MAIN_ONLY, ORDINARY]): SkillPort {
  const outcome: SkillLoadOutcome = {
    skills,
    diagnostics: [],
    totalDiscovered: skills.length,
  };
  return {
    async discoverSkills(): Promise<SkillLoadOutcome> {
      return { ...outcome, skills: [...outcome.skills] };
    },
    async loadSkill(request): Promise<SkillContent> {
      const metadata = skills.find(
        (candidate) =>
          candidate.name === request.name || candidate.qualifiedName === request.name,
      );
      if (!metadata) throw new Error(`Skill not found: ${request.name}`);
      return {
        metadata,
        content: "body",
        baseDirectory: metadata.directory,
        bytesRead: 4,
        sizeBytes: 4,
        truncated: false,
      };
    },
  };
}

// 空 CUA 策略：无官方 server、无 descriptor、无 catalog，isOfficial* 全为 false，
// 避免测试与 Computer Use 门禁耦合，只测 mainAgentOnly 这一条过滤。
const cuaPolicy = createOfficialCuaPolicy(new Set(), [], undefined);

function isNotAllowedForSubagent(error: unknown): boolean {
  return error instanceof Error && error.message === "Skill is not allowed for subagent";
}

test("子 Agent 清单不含主 Agent 专属技能，普通技能不受影响", async () => {
  const child = resolveSubagentSkillPort(parentPort(), undefined, cuaPolicy);
  assert.ok(child);
  const outcome = await child.discoverSkills({ workingDirectory: "/tmp" });
  const names = outcome.skills.map((item) => item.qualifiedName ?? item.name);
  assert.ok(!names.includes("language-art:language-art"), "专属技能不得出现在子清单");
  assert.ok(names.includes("plain:plain"), "普通技能仍可见");
});

test("子 Agent 显式加载专属技能被拒，白名单写明也不放行", async () => {
  const parent = parentPort();
  // profile.skills 白名单显式写了裸名与全名，仍不得放行。
  for (const allowlist of [
    ["language-art"],
    ["language-art:language-art"],
    ["language-art", "language-art:language-art"],
  ]) {
    const child = resolveSubagentSkillPort(parent, allowlist, cuaPolicy);
    assert.ok(child);
    await assert.rejects(
      child.loadSkill({ name: "language-art", workingDirectory: "/tmp" }),
      isNotAllowedForSubagent,
    );
    await assert.rejects(
      child.loadSkill({ name: "language-art:language-art", workingDirectory: "/tmp" }),
      isNotAllowedForSubagent,
    );
  }
});

test("主 Agent 路径仍可见、可加载专属技能", async () => {
  const parent = parentPort();
  const outcome = await parent.discoverSkills({ workingDirectory: "/tmp" });
  assert.ok(
    outcome.skills.some((item) => item.qualifiedName === "language-art:language-art"),
    "父 Port（主 Agent 路径）清单必须含专属技能",
  );
  const loaded = await parent.loadSkill({ name: "language-art", workingDirectory: "/tmp" });
  assert.equal(loaded.metadata.mainAgentOnly, true);
  assert.equal(loaded.content, "body");
});
