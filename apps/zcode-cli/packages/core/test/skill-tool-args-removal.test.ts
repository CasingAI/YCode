import assert from "node:assert/strict";
import test from "node:test";
import { SkillInputJsonSchema, SkillRuntimeInputSchema } from "@zcode/contracts";
import { skillToolEntry } from "../src/tool/handlers/skill.js";

test("Skill provider schema only exposes the skill name", () => {
  const properties = SkillInputJsonSchema.properties as Record<string, unknown>;
  const required = SkillInputJsonSchema.required as string[] | undefined;

  assert.deepEqual(Object.keys(properties), ["skill"]);
  assert.deepEqual(required, ["skill"]);
  assert.equal("args" in properties, false);
  assert.equal(SkillInputJsonSchema.additionalProperties, true);
});

test("Skill runtime schema keeps legacy name and args compatibility", () => {
  assert.deepEqual(
    SkillRuntimeInputSchema.parse({
      skill: "debug-mode",
      args: "legacy argument",
    }),
    {
      skill: "debug-mode",
      args: "legacy argument",
    },
  );
  assert.deepEqual(
    SkillRuntimeInputSchema.parse({
      name: "debug-mode",
      args: "legacy argument",
    }),
    {
      skill: "debug-mode",
      args: "legacy argument",
    },
  );
});

test("Skill tool description does not advertise arguments", () => {
  const description = skillToolEntry.metadata.description ?? "";

  assert.doesNotMatch(description, /`args`/i);
  assert.doesNotMatch(description, /optional arguments/i);
  assert.match(description, /Set `skill`/);
});
