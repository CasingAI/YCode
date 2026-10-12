import assert from "node:assert/strict";
import test from "node:test";
import type { SkillSummary } from "@zcode/shared";
import {
  groupScopedSkillsBySource,
  retainSystemSkillsOnStoreMismatch,
} from "@/settings/pluginCapabilityProjection.js";

function makeSkill(overrides: Partial<SkillSummary> & { name: string }): SkillSummary {
  return {
    id: overrides.name,
    description: `${overrides.name} description`,
    body: "",
    path: `/tmp/skills/${overrides.name}/SKILL.md`,
    scope: "workspace",
    enabled: true,
    ...overrides,
  };
}

const systemSkill = makeSkill({
  name: "bare",
  scope: "plugin",
  pluginName: "bare",
  path: "/cache/zcode-plugins-official/bare-plugin/skills/bare/SKILL.md",
});

const thirdPartySkill = makeSkill({
  name: "third-party-helper",
  scope: "plugin",
  pluginName: "third-party-plugin",
  pluginId: "third-party-plugin@community",
  path: "/home/user/.zcode/plugins/third-party-plugin/skills/third-party-helper/SKILL.md",
});

test("官方内置技能进入 system 组，非官方插件技能仍按 plugin 分节", () => {
  const groups = groupScopedSkillsBySource([systemSkill, thirdPartySkill], "工作区");
  const system = groups.find((group) => group.id === "system");
  assert.ok(system, "应存在 system 分组");
  assert.equal(system.source, "system");
  assert.deepEqual(
    system.skills.map((skill) => skill.name),
    ["bare"],
  );
  const pluginGroup = groups.find((group) => group.id === "plugin:third-party-plugin@community");
  assert.ok(pluginGroup, "第三方插件技能仍应按 plugin:<id> 分节");
  assert.deepEqual(
    pluginGroup.skills.map((skill) => skill.name),
    ["third-party-helper"],
  );
  assert.equal(groups.at(-1)?.id, "system", "system 分组应置底");
});

test("投影失配时系统技能被保留，非系统插件技能不保留", () => {
  const retained = retainSystemSkillsOnStoreMismatch([], [systemSkill, thirdPartySkill]);
  assert.deepEqual(
    retained.map((skill) => skill.name),
    ["bare"],
  );
});

test("已选中的系统技能不会被重复补回", () => {
  const retained = retainSystemSkillsOnStoreMismatch([systemSkill], [systemSkill]);
  assert.deepEqual(
    retained.map((skill) => skill.name),
    ["bare"],
  );
});
