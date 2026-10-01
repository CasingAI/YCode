import assert from "node:assert/strict";
import test from "node:test";
import type { BuiltinCommand, PluginCommand, UserCommand } from "@zcode/shared";
import type { ZCodeSlashCommand } from "@zcode/shared";
import { mergeSlashCommandsAfterCommandRefresh } from "../src/settings/pluginSlashCommandRefresh.js";

// 插件同步等场景会用刷新后的命令清单重建 custom 目录条目
// （docs/specs/command-model-binding.md）：UserCommand 的文件头绑定必须透传，
// 否则 `/` 面板的命令着色会静默消失，直到下一次完整目录水合才恢复。

const BINDING = { providerId: "zcode", modelId: "glm-5.3" };

function userCommand(overrides: Partial<UserCommand> = {}): UserCommand {
  return {
    id: "user-bound",
    name: "bound",
    prompt: "bound",
    content: "body",
    filePath: "/tmp/.zcode/commands/bound.md",
    source: "user",
    agentSource: "zcodeAgent",
    location: { source: "zcode", scope: "user", directoryPath: "/tmp/.zcode/commands" },
    enabled: true,
    scope: "user",
    ...overrides,
  };
}

function pluginCommand(overrides: Partial<PluginCommand> = {}): PluginCommand {
  return {
    id: "plugin-cmd",
    name: "from-plugin",
    prompt: "from-plugin",
    content: "body",
    filePath: "/tmp/plugins/x/commands/from-plugin.md",
    source: "plugin",
    enabled: true,
    pluginName: "x",
    pluginMarketplace: "official",
    pluginEnabled: true,
    scope: "global",
    ...overrides,
  };
}

const builtinEntry: BuiltinCommand = {
  id: "builtin:compact",
  name: "compact",
  description: "compact",
  inputHint: "/compact",
  source: "builtin",
  enabled: true,
  readOnly: true,
};

function customEntries(commands: readonly ZCodeSlashCommand[]) {
  return commands.filter((command) => command.source === "custom");
}

test("merge：UserCommand 的文件头绑定透传进重建的 custom 条目", () => {
  const merged = mergeSlashCommandsAfterCommandRefresh(
    [builtinEntry],
    [userCommand({ modelSelectionOverride: BINDING })],
  );
  assert.deepEqual(customEntries(merged), [
    {
      name: "bound",
      description: "",
      inputHint: "/bound",
      source: "custom",
      modelSelectionOverride: BINDING,
    },
  ]);
});

test("merge：无绑定的 UserCommand 与插件条目不产绑定字段", () => {
  const merged = mergeSlashCommandsAfterCommandRefresh([], [userCommand(), pluginCommand()]);
  const custom = customEntries(merged);
  assert.equal(custom.length, 2);
  for (const entry of custom) {
    assert.equal(entry.modelSelectionOverride, undefined);
    assert.equal("modelSelectionOverride" in entry, false);
  }
});
