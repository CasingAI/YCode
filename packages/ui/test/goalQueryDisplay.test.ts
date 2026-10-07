import assert from "node:assert/strict";
import test from "node:test";
import {
  GOAL_ECHO_CHIP_STYLE,
  GOAL_ECHO_SCOPE_STYLE,
  goalEchoMentionId,
  isGoalCommandLabel,
  materializeGoalEchoParts,
  parseGoalQueryDisplay,
  resolveGoalEchoScope,
} from "../src/v4/goalQueryDisplay.js";
import { parseV4VisibleSlashCommand } from "../src/v4/slashCommands.js";

// 用户气泡里 goal token 的作用域归属（docs/specs/goal-command-scope-and-decoration.md
// 「回显边界」与「回显作用域视觉」）。不变式：能画作用域的输入，发送端也必须认成 goal；
// 两边共用同一条 token 边界（行首或空白 + /goal|target + 空白或结尾）。

/** 与 ConversationUserInputContent 的渲染决策同构：芯片锚点、其后的 text 即目标正文。 */
function echoRoles(text: string, attachments: readonly unknown[] = []): string[] {
  const parts = materializeGoalEchoParts(text);
  const scope = resolveGoalEchoScope(text, parts, attachments);
  return parts.map((part, index) => {
    if (scope && index === scope.commandPartIndex) return "chip";
    if (scope && part.type === "text" && index > scope.commandPartIndex) return "goal-body";
    return "plain";
  });
}

test("句中 goal：前文普通正文、芯片锚点、目标正文入作用域（截图场景）", () => {
  // 实测输入：发送后气泡里目标正文掉回默认字色，看不出命令已生效。
  assert.deepEqual(echoRoles("test /goal 测试内容 123"), ["plain", "chip", "goal-body"]);
  assert.deepEqual(echoRoles("123 /goal 测试 123 213131231"), ["plain", "chip", "goal-body"]);
  assert.deepEqual(echoRoles("test /goal 123,123, 123"), ["plain", "chip", "goal-body"]);
});

test("回显作用域与编辑器共用同一套色值字重，芯片不自己画线", () => {
  assert.equal(GOAL_ECHO_CHIP_STYLE.color, "var(--color-command-node-foreground)");
  assert.equal(GOAL_ECHO_CHIP_STYLE.fontWeight, 500);
  // 芯片不带下划线：装饰覆盖不到 ::before 图标，线天生在图标左边断开。写回边框或
  // text-decoration 就是把这次返工撤销。
  assert.equal("borderBottom" in GOAL_ECHO_CHIP_STYLE, false);
  assert.equal("paddingBottom" in GOAL_ECHO_CHIP_STYLE, false);
  assert.equal("textDecoration" in GOAL_ECHO_CHIP_STYLE, false);
  assert.equal(GOAL_ECHO_SCOPE_STYLE.color, "var(--color-command-node-foreground)");
  assert.equal(GOAL_ECHO_SCOPE_STYLE.fontWeight, 500);
  assert.equal("textDecoration" in GOAL_ECHO_SCOPE_STYLE, false);
});

test("权威芯片的 mention id 与编辑器 slash/target 节点一致", () => {
  assert.equal(goalEchoMentionId("goal"), "slash:goal");
  assert.equal(goalEchoMentionId("/goal"), "slash:goal");
  assert.equal(goalEchoMentionId("target"), "slash:target");
});

test("中文句号后无空格仍能切出作用域", () => {
  assert.deepEqual(echoRoles("关系。/goal 一直分析"), ["plain", "chip", "goal-body"]);
});

test("顶格 goal：无前文，芯片与目标正文直接成作用域", () => {
  assert.deepEqual(echoRoles("/goal 修复登录"), ["chip", "goal-body"]);
});

test("前导空白归前文，不影响芯片锚点", () => {
  assert.deepEqual(echoRoles("  /goal 修复登录"), ["plain", "chip", "goal-body"]);
});

test("多个 /goal 取第一个，后续保持纯文本回显（与发送端一致）", () => {
  assert.deepEqual(echoRoles("问题 /goal 不要再糊弄我了 /goal"), [
    "plain",
    "chip",
    "goal-body",
    "plain",
  ]);
});

test("作用域内的其他 mention 保持 chip 渲染，正文段仍归作用域", () => {
  // parts：command、text「 修复 」、subagent、text「 登录」。@mention 与编辑器侧
  // PromptMentionNode 一样不画下划线，只有前后的 text 进入作用域。
  assert.deepEqual(echoRoles("/goal 修复 @reviewer 登录"), [
    "chip",
    "goal-body",
    "plain",
    "goal-body",
  ]);
});

test("控制命令同样画出作用域，与编辑器对控制词的下划线一致", () => {
  assert.deepEqual(echoRoles("/goal pause"), ["chip", "goal-body"]);
});

test("/target 与 /goal 同义", () => {
  assert.deepEqual(echoRoles("前面 /target 修复登录"), ["plain", "chip", "goal-body"]);
});

test("token 前必须是非空白字符边界", () => {
  assert.deepEqual(echoRoles("前缀/goal 修复"), ["plain"]);
  assert.deepEqual(echoRoles("邮箱a@b.com /goal 修复"), ["plain", "chip", "goal-body"]);
});

test("token 后必须跟空白或结尾，紧贴中文不切分", () => {
  assert.deepEqual(echoRoles("/goal3首先解决"), ["plain"]);
  assert.deepEqual(echoRoles("前面有话 /goal3首先解决"), ["plain"]);
});

test("附件门禁退化为普通文本时，整条不画作用域", () => {
  assert.deepEqual(echoRoles("123 /goal 测试 123", [{}]), ["plain", "plain", "plain"]);
  assert.deepEqual(echoRoles("123 /goal 测试 123"), ["plain", "chip", "goal-body"]);
  // 结构化上下文（contextAttachmentCount）与附件同一条门禁。
  const parts = materializeGoalEchoParts("123 /goal 测试 123");
  assert.equal(resolveGoalEchoScope("123 /goal 测试 123", parts, [], 1), null);
});

test("compact 与非 goal 命令不产生作用域", () => {
  assert.deepEqual(echoRoles("/compact 一下"), ["plain", "plain"]);
  assert.deepEqual(echoRoles("/plan 切到计划模式"), ["plain", "plain"]);
  assert.deepEqual(echoRoles("帮我修一下登录"), ["plain"]);
});

test("parts 里没有 goal 命令芯片时返回 null，不起作用域锚点", () => {
  // goal token 落在 markdown 链接目标里会被整体解析成 file part，没有芯片可锚定。
  const text = "[label]( /goal x)";
  assert.equal(resolveGoalEchoScope(text, materializeGoalEchoParts(text)), null);
});

test("作用域判定与发送端保持一致", () => {
  const cases = [
    "test /goal 测试内容 123",
    "/goal 修复登录",
    "  /goal 修复登录",
    "前缀/goal 修复",
    "/goal3首先解决",
    "问题 /goal 不要再糊弄我了 /goal",
    "邮箱a@b.com /goal 修复",
    "关系。/goal 一直分析",
  ];
  for (const text of cases) {
    const isGoal = parseV4VisibleSlashCommand(text) !== null;
    const scope = resolveGoalEchoScope(text, materializeGoalEchoParts(text));
    assert.equal(scope !== null, isGoal, `两侧对「${text}」的判定应一致`);
  }
});

test("切分前文时保留句号、丢掉 token 前的空格", () => {
  assert.deepEqual(parseGoalQueryDisplay("关系。/goal 一直分析"), {
    leadingText: "关系。",
    commandText: "/goal",
    trailingText: " 一直分析",
  });
  assert.deepEqual(parseGoalQueryDisplay("123 /goal 测试"), {
    leadingText: "123",
    commandText: "/goal",
    trailingText: " 测试",
  });
});

test("isGoalCommandLabel 大小写不敏感且容忍斜杠前缀", () => {
  assert.equal(isGoalCommandLabel("goal"), true);
  assert.equal(isGoalCommandLabel("/GOAL"), true);
  assert.equal(isGoalCommandLabel("target"), true);
  assert.equal(isGoalCommandLabel("compact"), false);
  assert.equal(isGoalCommandLabel(""), false);
});

// commandKind 三态权威（docs/specs/goal-command-scope-and-decoration.md「回显边界」
// 2026-10-07 权威化）：admission 冻结的行字段是唯一权威，文本判定只作旧 snapshot 回落。

/** 带 commandKind 的渲染决策，与 ConversationUserInputContent 的传参同构。 */
function echoRolesWithKind(
  text: string,
  commandKind: "sendText" | "sendGoalCommand",
  attachments: readonly unknown[] = [],
): string[] {
  const parts = materializeGoalEchoParts(text, undefined, commandKind);
  const scope = resolveGoalEchoScope(text, parts, attachments, 0, commandKind);
  return parts.map((part, index) => {
    if (scope && index === scope.commandPartIndex) return "chip";
    if (scope && part.type === "text" && index > scope.commandPartIndex) return "goal-body";
    return "plain";
  });
}

test("sendText 行正文含 /goal 字样：整条纯文本，不画芯片不画作用域", () => {
  assert.deepEqual(echoRolesWithKind("你可以用 /goal 设目标", "sendText"), [
    "plain",
    "plain",
    "plain",
  ]);
  assert.deepEqual(echoRolesWithKind("/goal 修复登录", "sendText"), ["plain", "plain"]);
});

test("sendText 不补句号紧贴的芯片（那是 goal 行才有的补齐逻辑）", () => {
  const parts = materializeGoalEchoParts("关系。/goal 一直分析", undefined, "sendText");
  assert.equal(
    parts.some((part) => part.type === "command"),
    false,
  );
});

test("sendGoalCommand 行照画芯片与作用域，跳过文本重判", () => {
  assert.deepEqual(echoRolesWithKind("/goal 修复登录", "sendGoalCommand"), ["chip", "goal-body"]);
  assert.deepEqual(echoRolesWithKind("关系。/goal 一直分析", "sendGoalCommand"), [
    "plain",
    "chip",
    "goal-body",
  ]);
  // admission 已保证 goal 行无附件；即便调用方误传附件，身份权威不受影响。
  assert.deepEqual(echoRolesWithKind("/goal 修复登录", "sendGoalCommand", [{}]), [
    "chip",
    "goal-body",
  ]);
});

test("commandKind 缺省（旧 snapshot）回落文本判定，与既有行为一致", () => {
  assert.deepEqual(echoRoles("你可以用 /goal 设目标"), ["plain", "chip", "goal-body"]);
  assert.deepEqual(echoRolesWithKind("你可以用 /goal 设目标", "sendText"), [
    "plain",
    "plain",
    "plain",
  ]);
});
