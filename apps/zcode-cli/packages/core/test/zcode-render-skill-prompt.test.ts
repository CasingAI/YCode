import assert from "node:assert/strict";
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

test("Dynamic Behavior 段带 zcode-render 的条件式加载指针", () => {
  const section = buildDynamicBehaviorSection();

  assert.equal(section.source, "dynamic_behavior");
  assert.equal(section.injectionTarget, "system");
  assert.equal(section.cacheHint, "dynamic");
  assert.ok(
    section.content.includes("If the `zcode-render` skill is listed, load it with the Skill tool"),
    "指针必须是条件式：技能未在清单里时不得强求加载",
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
