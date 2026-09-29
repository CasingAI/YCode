import assert from "node:assert/strict";
import test from "node:test";
import {
  findGoalTokenEndInText,
  hasGoalTokenInText,
  selectGoalScopeSegmentIndexes,
} from "../src/prompt-editor/goalScopeSelection.js";

// goal 目标范围高亮的范围选择（docs/specs/goal-command-scope-and-decoration.md）。
// 这里只测纯范围算法：节点装饰本身需要 Lexical 运行时，由 goalScopeDecoration.ts 承担。

const text = (): { isGoalCommand: boolean; hasText: boolean } => ({
  isGoalCommand: false,
  hasText: true,
});
const goal = (): { isGoalCommand: boolean; hasText: boolean } => ({
  isGoalCommand: true,
  hasText: false,
});
/** 非 goal 的命令芯片（`/init`、`/plan` 等）：有文字，但不是目标正文。 */
const otherCommand = (): { isGoalCommand: boolean; hasText: boolean } => ({
  isGoalCommand: false,
  hasText: true,
});
const empty = (): { isGoalCommand: boolean; hasText: boolean } => ({
  isGoalCommand: false,
  hasText: false,
});

test("goal 之前的正文不着色，goal 之后到末尾全部着色", () => {
  const scoped = selectGoalScopeSegmentIndexes([text(), text(), goal(), text(), text()]);
  assert.deepEqual([...scoped], [3, 4]);
});

test("没有 goal 时整段都不着色", () => {
  assert.equal(selectGoalScopeSegmentIndexes([text(), text(), text()]).size, 0);
});

test("goal 后紧跟的空文本节点不参与范围（避免空隙里留样式）", () => {
  const scoped = selectGoalScopeSegmentIndexes([text(), goal(), empty(), text()]);
  assert.deepEqual([...scoped], [3]);
});

test("句中多个 goal 时以第一个为准，覆盖到末尾", () => {
  // 发送端 parseV4VisibleSlashCommand 取第一个 token，装饰必须与之一致：
  // 「一条输入只有一个命令，命令之后的全部正文都是它的参数」。
  const scoped = selectGoalScopeSegmentIndexes([text(), goal(), text(), goal(), text()]);
  assert.deepEqual([...scoped], [2, 4]);
});

test("goal 之后出现的其它命令芯片，其参数文本仍属目标正文", () => {
  // 一条输入只允许一个命令，第二个命令插不进来（见 SlashCommandPlugin 的拦截）；
  // 真出现时，发送端仍把它当参数，所以装饰范围必须与下发范围一致。
  const scoped = selectGoalScopeSegmentIndexes([text(), goal(), text(), otherCommand(), text()]);
  assert.deepEqual([...scoped], [2, 3, 4]);
});

test("goal 在最末位时，自身之后的空正文不产生样式", () => {
  assert.equal(selectGoalScopeSegmentIndexes([text(), goal()]).size, 0);
  assert.equal(selectGoalScopeSegmentIndexes([text(), goal(), empty()]).size, 0);
});

test("整段只有一个 goal 且带目标时，着色覆盖目标正文", () => {
  const scoped = selectGoalScopeSegmentIndexes([text(), goal(), text()]);
  assert.deepEqual([...scoped], [2]);
});

test("空段落不报错", () => {
  assert.equal(selectGoalScopeSegmentIndexes([]).size, 0);
});

// 手打 `/goal`（没从面板选中）时，编辑器里只有纯文本节点，没有 chip。
// 曾经只认 chip，导致这类输入完全没有高亮——实测节点从头到尾是一个 TextNode，
// token 与目标正文同处一节点，不切分就没法只给后半段上色。

test("手打输入能识别出 goal token", () => {
  assert.equal(hasGoalTokenInText("123 /goal 测试 123 213131231"), true);
  assert.equal(hasGoalTokenInText("/goal 测试目标"), true);
  assert.equal(hasGoalTokenInText("前面 /target 修复"), true);
  assert.equal(hasGoalTokenInText("关系。/goal 一直分析"), true);
});

test("没有 goal token 的普通文本不误判", () => {
  assert.equal(hasGoalTokenInText("帮我修一下登录"), false);
  assert.equal(hasGoalTokenInText("前缀/goal 修复"), false);
  assert.equal(hasGoalTokenInText("/goal3首先解决"), false);
  assert.equal(hasGoalTokenInText(""), false);
});

test("token 结束下标即目标正文起点，用于切分节点", () => {
  assert.equal(findGoalTokenEndInText("123 /goal 测试 123"), "123 /goal".length);
  assert.equal(findGoalTokenEndInText("/goal 测试目标"), "/goal".length);
  // token 独占整段时返回文本长度，切分层据此不切（后面没有正文可着色）
  assert.equal(findGoalTokenEndInText("/goal"), "/goal".length);
  assert.equal(findGoalTokenEndInText("没有 token"), -1);
});

test("切分后：前半段含 token、后半段是待装饰正文", () => {
  const before = "123 /goal";
  const tokenEnd = findGoalTokenEndInText(before);
  const after = " 测试 123 213131231";
  // 切分前是一整个节点
  assert.equal(tokenEnd, before.length);
  // 切分后前半段已不含 token，不会被再次切分（幂等）
  assert.equal(hasGoalTokenInText(before.slice(0, tokenEnd)), true);
  assert.equal(hasGoalTokenInText(after), false);
  // 前半段作为 goal 段，后半段进入可装饰范围
  const scoped = selectGoalScopeSegmentIndexes([
    { isGoalCommand: true, hasText: true },
    { isGoalCommand: false, hasText: true },
  ]);
  assert.deepEqual([...scoped], [1]);
});
