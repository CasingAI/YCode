import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSlashSuggestions,
  filterCommandSuggestions,
  isSlashCommandSuggestion,
  normalizeSlashCommandValue,
  type ZCodeSlashCommand,
} from "../src/slashCommandHelpers.js";
import type { PromptInputSuggestionItem } from "../src/lib/promptInputTriggers.js";

// 一条输入只允许一个命令（docs/specs/goal-command-scope-and-decoration.md「一条输入一个命令」）。
// 命令之后的全部正文会整体归为该命令的参数：第二个命令插进来既不会执行也不会被拒绝，
// 只会静默变成参数文本，所以拦截点在输入层，不在发送层。

const pluginSource = readFileSync(
  new URL("../src/SlashCommandPlugin.tsx", import.meta.url),
  "utf8",
);

const suggestion = (id: string): PromptInputSuggestionItem => ({
  id,
  trigger: "/",
  value: normalizeSlashCommandValue(id.split(":")[1] ?? ""),
  label: `/${id}`,
  description: "",
  keywords: [],
});

test("已有命令芯片时不再提供命令候选", () => {
  const commands = filterCommandSuggestions(
    [suggestion("slash:goal"), suggestion("slash:init"), suggestion("slash:plan")],
    true,
  );
  assert.deepEqual(commands, []);
});

test("还没有命令芯片时命令候选原样返回", () => {
  const catalog = [suggestion("slash:goal"), suggestion("slash:init")];
  assert.deepEqual(filterCommandSuggestions(catalog, false), catalog);
});

test("拦截只认 CLI 命令候选，skills / subagents / App 命令不受影响", () => {
  // skills 与 subagents 是 mention 载荷（`/goal 修复 @reviewer 登录` 正是这个形态）；
  // App 命令选中即执行、不进正文，不会变成参数文本。
  assert.equal(isSlashCommandSuggestion(suggestion("slash:goal")), true);
  assert.equal(isSlashCommandSuggestion(suggestion("app-slash:side")), false);
  assert.equal(isSlashCommandSuggestion(suggestion("skill:review")), false);
  assert.equal(isSlashCommandSuggestion(suggestion("subagent:reviewer")), false);
});

test("id 前缀与 buildSlashSuggestions 实际产出一致", () => {
  const catalog: ZCodeSlashCommand[] = [
    { name: "/init", description: "初始化" } as ZCodeSlashCommand,
  ];
  const built = buildSlashSuggestions(catalog);
  assert.equal(built.length, 1);
  assert.equal(isSlashCommandSuggestion(built[0]!), true);
});

test("SlashCommandPlugin 在候选构建与插入两处都核过「本条还没有命令」", () => {
  // 面板状态可能落后一帧（键盘直接确认候选），所以插入前要再核一次。
  assert.match(
    pluginSource,
    /filterCommandSuggestions\(\s*commandSuggestions,\s*hasCommandMention\s*\)/,
  );
  assert.match(
    pluginSource,
    /isSlashCommandSuggestion\(suggestion\) && hasCommandMentionInEditorState\(\)/,
  );
  // 读取 Lexical 状态只能发生在 editorState.read() 里，由 update listener 采一次存 state。
  assert.match(
    pluginSource,
    /editorState\.read\(\(\) => \{[\s\S]*hasCommandMentionInEditorState\(\)/,
  );
});
