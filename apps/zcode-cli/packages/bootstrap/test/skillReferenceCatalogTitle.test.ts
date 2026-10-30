import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import { zcodeSkillsReferenceCatalogResultSchema } from "@zcode/shared";
import { z } from "zod";
import { listZCodeSkills } from "../src/skills.js";
import { getSkillReferenceCatalog } from "../src/zcode-protocol/skill-reference-catalog.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "../src/zcode-protocol/server-types.js";

// docs/specs/skill-reference-catalog-title.md：frontmatter title 必须经真实发现、
// capability opt-in 与 bootstrap 投影到达 skills/referenceCatalog，且不改变 name/id/path/scope。

const TITLED_SKILL = "catalog-title-titled";
const UNTITLED_SKILL = "catalog-title-untitled";
const PLUGIN_SKILL = "catalog-title-plugin";
const PLUGIN_NAME = "catalog-title-demo-plugin";
const PLUGIN_TITLE = "Plugin Friendly";
const PROJECT_TITLE = "Workspace Friendly";

// 旧 Agent/客户端只认识不含 title 的严格形状。
const legacyEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    path: z.string().min(1),
    scope: z.enum(["workspace", "user", "plugin"]),
    enabled: z.literal(true),
    pluginName: z.string().min(1).optional(),
  })
  .strict();
const legacyResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    skills: z.array(legacyEntrySchema),
  })
  .strict();

function writeSkill(skillDirectory: string, frontmatter: string): string {
  mkdirSync(skillDirectory, { recursive: true });
  const skillPath = join(skillDirectory, "SKILL.md");
  writeFileSync(skillPath, `---\n${frontmatter}\n---\n\n# Body\n`);
  return skillPath;
}

/** 真实 workspace：project 技能 + 内联插件技能；插件经 .zcode/config.json 的 dirs 启用。 */
function createWorkspaceFixture(): string {
  const workspacePath = mkdtempSync(join(tmpdir(), "skill-catalog-title-"));
  writeSkill(
    join(workspacePath, ".zcode", "skills", TITLED_SKILL),
    `name: ${TITLED_SKILL}\ntitle: ${PROJECT_TITLE}\ndescription: demo`,
  );
  writeSkill(
    join(workspacePath, ".zcode", "skills", UNTITLED_SKILL),
    `name: ${UNTITLED_SKILL}\ndescription: demo`,
  );

  const pluginRoot = mkdtempSync(join(tmpdir(), "skill-catalog-plugin-"));
  mkdirSync(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0" }),
  );
  writeSkill(
    join(pluginRoot, "skills", PLUGIN_SKILL),
    `name: ${PLUGIN_SKILL}\ntitle: ${PLUGIN_TITLE}\ndescription: demo`,
  );
  writeFileSync(
    join(workspacePath, ".zcode", "config.json"),
    JSON.stringify({ plugins: { dirs: [pluginRoot] } }),
  );
  return workspacePath;
}

function createContext(sessions = new Map<string, unknown>()): ZCodeProtocolAgentServerContext {
  return {
    deps: { env: {} },
    sessions,
  } as unknown as ZCodeProtocolAgentServerContext;
}

function createSessionContext(outcome: SkillLoadOutcome): ZCodeProtocolAgentServerContext {
  return createContext(new Map([["session-1", { app: { getSkillCatalog: async () => outcome } }]]));
}

function catalogParams(workspacePath: string, sessionId?: string, includeTitle?: boolean) {
  return {
    workspace: {
      workspacePath,
      workspaceKey: `local:${workspacePath}`,
    },
    ...(includeTitle ? { includeTitle: true } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function makeSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: "fake-skill",
    title: "Fake Friendly",
    description: "demo",
    path: "/tmp/fake-skill/SKILL.md",
    directory: "/tmp/fake-skill",
    rootPath: "/tmp",
    scope: "project",
    source: "zcode",
    safeToAutoLoad: true,
    frontmatterKeys: ["name", "title", "description"],
    ...overrides,
  };
}

test("workspace authority 在 opt-in 后透传非插件与插件技能的真实 title", async () => {
  const workspacePath = createWorkspaceFixture();
  const result = await getSkillReferenceCatalog(
    createContext(),
    catalogParams(workspacePath, undefined, true),
  );

  assert.equal(result.authority, "workspace");
  const titled = result.skills.find((skill) => skill.name === TITLED_SKILL);
  assert.ok(titled);
  assert.equal(titled.title, PROJECT_TITLE);
  assert.equal(titled.scope, "workspace");
  // id/name/path 的生成规则保持不变。
  assert.equal(titled.id, `glm:workspace:${titled.path}`);
  assert.equal(titled.path.endsWith(join(TITLED_SKILL, "SKILL.md")), true);

  const plugin = result.skills.find((skill) => skill.name === PLUGIN_SKILL);
  assert.ok(plugin);
  assert.equal(plugin.title, PLUGIN_TITLE);
  assert.equal(plugin.scope, "plugin");
  assert.equal(plugin.pluginName, PLUGIN_NAME);

  const untitled = result.skills.find((skill) => skill.name === UNTITLED_SKILL);
  assert.ok(untitled);
  assert.equal("title" in untitled, false);

  // schema round-trip：title 经过协议解析后仍保留。
  const parsed = zcodeSkillsReferenceCatalogResultSchema.parse(result);
  assert.equal(parsed.skills.find((skill) => skill.name === PLUGIN_SKILL)?.title, PLUGIN_TITLE);
  assert.equal(parsed.skills.find((skill) => skill.name === TITLED_SKILL)?.title, PROJECT_TITLE);
});

test("session authority 冻结快照同样透传 title 且插件/非插件 scope 不变", async () => {
  const workspacePath = createWorkspaceFixture();
  // 与 runtime 冷恢复一致：先经过真实发现，再把结果作为 Session 冻结快照。
  const outcome = await listZCodeSkills({ env: {}, workingDirectory: workspacePath });
  const context = createSessionContext(outcome);

  const result = await getSkillReferenceCatalog(
    context,
    catalogParams(workspacePath, "session-1", true),
  );

  assert.equal(result.authority, "session");
  const titled = result.skills.find((skill) => skill.name === TITLED_SKILL);
  assert.ok(titled);
  assert.equal(titled.title, PROJECT_TITLE);
  assert.equal(titled.scope, "workspace");

  const plugin = result.skills.find((skill) => skill.name === PLUGIN_SKILL);
  assert.ok(plugin);
  assert.equal(plugin.title, PLUGIN_TITLE);
  assert.equal(plugin.scope, "plugin");
  assert.equal(plugin.pluginName, PLUGIN_NAME);
  assert.equal(plugin.id, `glm:plugin:${plugin.path}`);
});

test("新 Agent 无 opt-in 时保持旧 wire，结果可被旧 strict schema 解析", async () => {
  const workspacePath = createWorkspaceFixture();
  const result = await getSkillReferenceCatalog(createContext(), catalogParams(workspacePath));

  const titled = result.skills.find((skill) => skill.name === TITLED_SKILL);
  assert.ok(titled);
  assert.equal("title" in titled, false);
  const plugin = result.skills.find((skill) => skill.name === PLUGIN_SKILL);
  assert.ok(plugin);
  assert.equal("title" in plugin, false);
  assert.doesNotThrow(() => legacyResultSchema.parse(result));
});

test("catalog schema 兼容旧 peer 不含 title 的 payload", () => {
  const parsed = zcodeSkillsReferenceCatalogResultSchema.parse({
    authority: "workspace",
    skills: [
      {
        id: "glm:user:/tmp/legacy/SKILL.md",
        name: "legacy",
        description: "demo",
        path: "/tmp/legacy/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ],
  });
  assert.equal(parsed.skills[0]?.name, "legacy");
  assert.equal("title" in (parsed.skills[0] ?? {}), false);
});

test("空 skills + skill_scan_failed 使 catalog RPC 失败而不是成功空表", async () => {
  const outcome: SkillLoadOutcome = {
    skills: [],
    diagnostics: [{ code: "skill_scan_failed", severity: "warning", message: "EACCES: skills" }],
    totalDiscovered: 0,
  };
  await assert.rejects(
    getSkillReferenceCatalog(createSessionContext(outcome), catalogParams("/tmp/ws", "session-1")),
    (error: unknown) =>
      error instanceof ProtocolRequestError &&
      error.code === -32603 &&
      error.message.includes("EACCES"),
  );
});

test("真正的空目录返回成功空表", async () => {
  const outcome: SkillLoadOutcome = { skills: [], diagnostics: [], totalDiscovered: 0 };
  const result = await getSkillReferenceCatalog(
    createSessionContext(outcome),
    catalogParams("/tmp/ws", "session-1"),
  );
  assert.deepEqual(result, { authority: "session", skills: [] });
});

test("普通 warning 或单项失败不拒绝 catalog", async () => {
  const partial: SkillLoadOutcome = {
    skills: [makeSkill()],
    diagnostics: [
      { code: "skill_read_failed", severity: "warning", message: "unreadable", path: "/tmp/x" },
    ],
    totalDiscovered: 2,
  };
  const partialResult = await getSkillReferenceCatalog(
    createSessionContext(partial),
    catalogParams("/tmp/ws", "session-1"),
  );
  assert.equal(partialResult.skills.length, 1);

  const partialScan: SkillLoadOutcome = {
    skills: [makeSkill({ name: "survivor" })],
    diagnostics: [
      { code: "skill_scan_failed", severity: "warning", message: "root failed", path: "/tmp/root" },
    ],
    totalDiscovered: 1,
  };
  const partialScanResult = await getSkillReferenceCatalog(
    createSessionContext(partialScan),
    catalogParams("/tmp/ws", "session-1"),
  );
  assert.equal(partialScanResult.skills[0]?.name, "survivor");
});
