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

// 顶格命令的参数正文和 goal 目标正文一样会被下发（compact 的 instructions、plan 的
// task），所以着色范围必须完全一致，否则用户看到的和实际生效的不是一回事。

test("顶格 /compact 之后的参数正文进入着色范围", () => {
  const before = "/compact";
  const tokenEnd = findGoalTokenEndInText(before);
  assert.equal(tokenEnd, before.length);
  const scoped = selectGoalScopeSegmentIndexes([
    { isGoalCommand: true, hasText: true },
    { isGoalCommand: false, hasText: true },
  ]);
  assert.deepEqual([...scoped], [1]);
});

test("顶格 /compact 带参时能识别出 token 与参数起点", () => {
  const full = "/compact 1231231";
  assert.equal(hasGoalTokenInText(full), true);
  assert.equal(findGoalTokenEndInText(full), "/compact".length);
  // token 独占整段时返回文本长度，切分层据此不切（后面没有正文可着色）
  assert.equal(findGoalTokenEndInText("/compact"), "/compact".length);
});

test("顶格 /plan 与 /init 同样按命令 token 处理", () => {
  assert.equal(hasGoalTokenInText("/plan 切计划"), true);
  assert.equal(findGoalTokenEndInText("/plan 切计划"), "/plan".length);
  assert.equal(hasGoalTokenInText("/init"), true);
});

test("句中 /compact 不是命令，不进入着色范围", () => {
  // 句中 compact 发送端只当普通文本。给它着色等于承诺系统不兑现的事。
  assert.equal(hasGoalTokenInText("关系。/compact 压缩一下"), false);
  assert.equal(findGoalTokenEndInText("关系。/compact 压缩一下"), -1);
});

test("isTopLevelNode=false 时顶格 token 一律不算命令", () => {
  // 降级把芯片换成文本节点后，`/compact` 会成为一个「自己看起来顶格」的独立节点。
  // 不带位置事实就会重新认它当命令 token，把后面的参数继续染蓝——芯片没了、蓝还在。
  assert.equal(hasGoalTokenInText("/compact 1231231"), true);
  assert.equal(hasGoalTokenInText("/compact 1231231", false), false);
  assert.equal(findGoalTokenEndInText("/compact 1231231", false), -1);
  // 切分层同样要用位置事实，否则句中那段会被切开，前半段变成「看起来顶格」的节点。
  assert.equal(findGoalTokenEndInText("12313213 /compact 12313123", false), -1);
});

test("goal 的句中语义不受 isTopLevelNode 影响", () => {
  // goal 句中命中本就是命令语义，token 边界由 shared 正则自行判定，与位置无关。
  assert.equal(hasGoalTokenInText("前面 /goal 修复登录", false), true);
  assert.equal(findGoalTokenEndInText("前面 /goal 修复登录", false), "前面 /goal".length);
});

// 错位芯片的着色设防：降级插件会把它换成文本节点，这里先设一道防是为了消灭
// 「补字到降级执行之间」那一帧的蓝色闪烁。位置判定与降级共用同一份函数。

test("错位芯片的形状读作非命令，不触发作用域着色", () => {
  // 装饰层把每个节点读成一个 segment；错位芯片必须读成普通文本，否则它后面的正文
  // 会在降级执行前先被染蓝。真正的判定在 headless 用例（topLevelCommandPlacement.test.ts）。
  const scoped = selectGoalScopeSegmentIndexes([
    { isGoalCommand: false, hasText: true },
    { isGoalCommand: false, hasText: false },
    { isGoalCommand: false, hasText: true },
  ]);
  assert.equal(scoped.size, 0);
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
