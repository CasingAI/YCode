import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES,
  isModelBindableBuiltinSlashCommandName,
  listAppBuiltinSlashCommands,
} from "../src/zcode-slash-command-help.js";
import {
  formatCommandFrontmatterMode,
  formatCommandFrontmatterModelSelection,
  parseCommandFrontmatterMode,
  parseCommandFrontmatterModelSelection,
} from "../src/command-types.js";
import { sameModelSelection } from "../src/model-selection.js";
import { zcodeSlashCommandSchema } from "../src/zcode-protocol/index.js";

// 命令绑定模型（docs/specs/command-model-binding.md）的纯函数边界：
// frontmatter 互转、内置清单、可绑定名单与稀疏比较。双侧解析器（services 与 CLI
// catalog 投影）都依赖这些函数，坏值必须收敛为「未绑定」而不是抛错。

test("parseCommandFrontmatterModelSelection：合法 provider/model 与档位", () => {
  assert.deepEqual(parseCommandFrontmatterModelSelection("openai/gpt-5", "high"), {
    providerId: "openai",
    modelId: "gpt-5",
    options: { reasoningLevel: "high" },
  });
  assert.deepEqual(parseCommandFrontmatterModelSelection("openai/gpt-5"), {
    providerId: "openai",
    modelId: "gpt-5",
  });
  // 档位空白等价于未提供，不能生成空字符串 reasoningLevel。
  assert.deepEqual(parseCommandFrontmatterModelSelection("openai/gpt-5", "  "), {
    providerId: "openai",
    modelId: "gpt-5",
  });
});

test("parseCommandFrontmatterModelSelection：坏值收敛为 undefined", () => {
  assert.equal(parseCommandFrontmatterModelSelection(""), undefined);
  assert.equal(parseCommandFrontmatterModelSelection("   "), undefined);
  assert.equal(parseCommandFrontmatterModelSelection("gpt-5"), undefined);
  assert.equal(parseCommandFrontmatterModelSelection("openai/gpt-5/mini"), undefined);
  assert.equal(parseCommandFrontmatterModelSelection("openai//gpt"), undefined);
  assert.equal(parseCommandFrontmatterModelSelection("/gpt-5"), undefined);
  assert.equal(parseCommandFrontmatterModelSelection("openai/"), undefined);
  assert.equal(parseCommandFrontmatterModelSelection("open ai/gpt-5"), undefined);
});

test("parseCommandFrontmatterMode：大小写不敏感，坏值收敛为 undefined", () => {
  assert.equal(parseCommandFrontmatterMode("yolo"), "yolo");
  assert.equal(parseCommandFrontmatterMode("YOLO"), "yolo");
  assert.equal(parseCommandFrontmatterMode("  plan  "), "plan");
  assert.equal(parseCommandFrontmatterMode("ReadOnly"), "readonly");
  assert.equal(parseCommandFrontmatterMode(undefined), undefined);
  assert.equal(parseCommandFrontmatterMode(""), undefined);
  assert.equal(parseCommandFrontmatterMode("   "), undefined);
  assert.equal(parseCommandFrontmatterMode("agent"), undefined);
  assert.equal(parseCommandFrontmatterMode("auto"), undefined);
  assert.equal(parseCommandFrontmatterMode("yolo "), "yolo");
});

test("formatCommandFrontmatterMode：原样输出合法档位", () => {
  assert.deepEqual(formatCommandFrontmatterMode("yolo"), { mode: "yolo" });
  assert.deepEqual(formatCommandFrontmatterMode("plan"), { mode: "plan" });
});

test("formatCommandFrontmatterModelSelection：无档位时不输出 effort 键", () => {
  assert.deepEqual(
    formatCommandFrontmatterModelSelection({ providerId: "openai", modelId: "gpt-5" }),
    { model: "openai/gpt-5" },
  );
  assert.deepEqual(
    formatCommandFrontmatterModelSelection({
      providerId: "openai",
      modelId: "gpt-5",
      options: { reasoningLevel: "high" },
    }),
    { model: "openai/gpt-5", effort: "high" },
  );
});

test("frontmatter 互转 round-trip 保持绑定语义", () => {
  const selection = {
    providerId: "zcode",
    modelId: "glm-5.3",
    options: { reasoningLevel: "medium" },
  };
  const formatted = formatCommandFrontmatterModelSelection(selection);
  assert.deepEqual(parseCommandFrontmatterModelSelection(formatted.model, formatted.effort), {
    providerId: "zcode",
    modelId: "glm-5.3",
    options: { reasoningLevel: "medium" },
  });
});

test("listAppBuiltinSlashCommands：恰为 App 可见的 4 个内置命令", () => {
  const commands = listAppBuiltinSlashCommands();
  // help 里的 goal / compact / init 加上 App-only 的 plan，合成 App 全部内置命令。
  assert.deepEqual(
    commands.map((command) => command.name).sort(),
    [...APP_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES, "plan"].sort(),
  );
  assert.equal(commands.length, 4);
  assert.ok(commands.every((command) => command.source === "builtin"));
  // plan 是 App-only 条目，CLI help 里没有，必须由这份清单独立提供。
  const plan = commands.find((command) => command.name === "plan");
  assert.equal(plan?.inputHint, "/plan [task]");
});

test("isModelBindableBuiltinSlashCommandName：只有压缩可绑定", () => {
  assert.equal(isModelBindableBuiltinSlashCommandName("compact"), true);
  // 初始化改为强制跟随默认；存量配置残留不迁移，只是不再生效。
  assert.equal(isModelBindableBuiltinSlashCommandName("init"), false);
  assert.equal(isModelBindableBuiltinSlashCommandName("goal"), false);
  assert.equal(isModelBindableBuiltinSlashCommandName("plan"), false);
  assert.equal(isModelBindableBuiltinSlashCommandName("commit"), false);
});

test("sameModelSelection：三字段稀疏比较，undefined 与缺省等价", () => {
  assert.equal(
    sameModelSelection(
      { providerId: "openai", modelId: "gpt-5" },
      {
        providerId: "openai",
        modelId: "gpt-5",
      },
    ),
    true,
  );
  assert.equal(
    sameModelSelection(
      { providerId: "openai", modelId: "gpt-5" },
      { providerId: "openai", modelId: "gpt-5", options: {} },
    ),
    true,
  );
  assert.equal(
    sameModelSelection(
      { providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "high" } },
      { providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "low" } },
    ),
    false,
  );
  assert.equal(sameModelSelection(undefined, { providerId: "openai", modelId: "gpt-5" }), false);
  assert.equal(sameModelSelection(undefined, undefined), true);
});

// 旧协议 slash 命令 schema（docs/specs/composer-model-switch-continuity.md 根因回归）：
// CLI 目录投影会输出命令绑定字段，strict 下漏字段会导致 readPresentation 全量
// 拒收、目录水合失败、模型切换不可用。绑定字段必须可解析，未知字段仍须拒收。
test("zcodeSlashCommandSchema：绑定字段可解析、未知字段仍拒收", () => {
  // 真实命中形状：~/.zcode/commands/test-hello.md 文件头 model 绑定。
  const bound = {
    name: "test-hello",
    description: "test",
    inputHint: "/test-hello",
    source: "custom",
    modelSelectionOverride: {
      providerId: "opencode-go-chat",
      modelId: "longcat-2.5-preview-free",
    },
  };
  assert.deepEqual(zcodeSlashCommandSchema.parse(bound), bound);
  // 模式绑定形状：文件头 mode: yolo 投影为 modeOverride。
  const modeBound = {
    name: "test-mode",
    description: "test",
    inputHint: "/test-mode",
    source: "custom",
    modeOverride: "yolo",
  };
  assert.deepEqual(zcodeSlashCommandSchema.parse(modeBound), modeBound);
  // 坏模式值拒收（目录装配侧已收敛为无绑定，不应走到协议层）。
  assert.throws(() => zcodeSlashCommandSchema.parse({ ...modeBound, modeOverride: "agent" }));
  // 未绑定时字段缺省，同样可解析。
  const unbound = { name: "goal", description: "goal", source: "builtin" };
  assert.deepEqual(zcodeSlashCommandSchema.parse(unbound), unbound);
  // strict 不放松：未知字段仍拒收。
  assert.throws(() => zcodeSlashCommandSchema.parse({ ...unbound, unknownField: 1 }));
});
