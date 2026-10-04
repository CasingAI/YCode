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
    true,
  );
  assert.deepEqual(commands, []);
});

test("还没有命令芯片时命令候选原样返回", () => {
  const catalog = [suggestion("slash:goal"), suggestion("slash:init")];
  assert.deepEqual(filterCommandSuggestions(catalog, false, true), catalog);
});

test("句中触发时顶格命令不再出现在候选里", () => {
  // `/compact`、`/plan`、`/init` 只在顶格才是命令。句中仍然弹出候选等于让面板再次
  // 承诺系统不兑现的事：选中只会得到一句永远不会被执行的纯文本。
  const filtered = filterCommandSuggestions(
    [
      suggestion("slash:goal"),
      suggestion("slash:compact"),
      suggestion("slash:plan"),
      suggestion("slash:init"),
      suggestion("skill:review"),
    ],
    false,
    false,
  );
  assert.deepEqual(
    filtered.map((item) => item.value),
    ["goal", "review"],
  );
});

test("句中过滤只看命令名，不因别名或大小写漏掉顶格命令", () => {
  const filtered = filterCommandSuggestions(
    [suggestion("slash:Compact"), suggestion("slash:compress"), suggestion("slash:goal")],
    false,
    false,
  );
  assert.deepEqual(
    filtered.map((item) => item.value),
    ["goal"],
  );
});

test("顶格触发时位置过滤不生效，compact 仍是正常候选", () => {
  const catalog = [suggestion("slash:compact"), suggestion("slash:goal")];
  assert.deepEqual(filterCommandSuggestions(catalog, false, true), catalog);
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
    /filterCommandSuggestions\(\s*commandSuggestions,\s*hasCommandMention,\s*isTopLevelTrigger\s*\)/,
  );
  assert.match(
    pluginSource,
    /isSlashCommandSuggestion\(suggestion\) &&\s*\n?\s*findCommandMentionNameInEditorState\(\) !== null/,
  );
  // 读取 Lexical 状态只能发生在 editorState.read() 里，由 update listener 采一次存 state。
  assert.match(
    pluginSource,
    /editorState\.read\(\(\) => \{[\s\S]*findCommandMentionNameInEditorState\(\)/,
  );
});

test("顶格命令落在句中时插入纯文本而不是命令芯片", () => {
  // 面板过滤已经挡住句中候选，但键盘直接确认可能落后一帧。落子处再核一次位置，
  // 句中命中就插普通文本——气泡不会把它画成命令，发送端也不会静默失效。
  assert.match(pluginSource, /isTopLevelOnlySlashCommandName\(suggestion\.value\)/);
  assert.match(
    pluginSource,
    /\$isTopLevelSlashTriggerAt\(selectionState\.node, tokenStart\)[\s\S]*\$createTextNode\(`\/\$\{suggestion\.value\} `\)/,
  );
});
