import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createContextBuilder } from "../src/context/builder.js";
import { buildDynamicBehaviorSection } from "../src/context/dynamic-sections.js";
import type { EnvInfo } from "@zcode/contracts";

const ENV_INFO: EnvInfo = {
  cwd: "/workspace",
  platform: "darwin",
  shell: "zsh",
  osVersion: "darwin 23.6.0",
  nodeVersion: "v22.0.0",
};

const SKILL_BODY_PATH = fileURLToPath(
  new URL("../../zcode-render-plugin/skills/zcode-render/SKILL.md", import.meta.url),
);

test("Dynamic Behavior 段带 zcode-render 的加载指针", () => {
  const section = buildDynamicBehaviorSection();

  assert.equal(section.source, "dynamic_behavior");
  assert.equal(section.injectionTarget, "system");
  assert.equal(section.cacheHint, "dynamic");
  assert.ok(
    section.content.includes("If the `zcode-render` skill is listed"),
    "指针必须以技能清单为前提：技能未在清单里时不得强求加载",
  );
  assert.ok(
    section.content.includes(
      "you must load it with the Skill tool before writing your final answer",
    ),
    "加载义务必须无条件：不能把加载前提写成回答的内容形态",
  );
});

test("zcode-render 指针不把加载义务挂在内容形态条件上", () => {
  const section = buildDynamicBehaviorSection();

  assert.ok(
    !section.content.includes("before composing an answer that has several parallel points"),
    "把内容形态写成加载前提会让模型先判断形态再决定加载，产生漏判",
  );
});

test("zcode-render 指针不随 presentationSurface 变化", () => {
  // 输出格式规范是模型的基本表达契约，不受桌面专属灰度开关控制：
  // 终端与桌面端都要让模型知道折叠区块的存在。
  for (const presentationSurface of ["terminal", "zcode_desktop"] as const) {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: ENV_INFO,
      presentationSurface,
    }).build();

    const systemText = result.systemMessages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");

    assert.ok(
      systemText.includes("`zcode-render` skill is listed"),
      `${presentationSurface} 端缺少 zcode-render 指针`,
    );
  }
});

test("技能正文带可判定的折叠规则", () => {
  const body = readFileSync(SKILL_BODY_PATH, "utf8");

  assert.ok(body.includes("### 判定步骤"), "技能正文必须给出判定步骤");
  assert.ok(body.includes("必须折叠"), "判定步骤必须给出必答动作");
  assert.ok(body.includes("折叠不会丢内容"), "技能正文必须消除模型对丢内容的顾虑");
  assert.ok(body.includes("不折叠"), "判定步骤必须给出反例");
});
