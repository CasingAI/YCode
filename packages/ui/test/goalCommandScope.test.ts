import assert from "node:assert/strict";
import test from "node:test";
import { parseV4VisibleSlashCommand, v4QueuedCommandText } from "../src/v4/slashCommands.js";

// /goal 句中命中边界（docs/specs/goal-command-scope-and-decoration.md）：
// 面板按 `(^|\s)` 允许句中弹图标，发送端过去用 `^` 锚定整串，导致图标出现但命令不生效。

test("顶格 /goal 仍然识别为命令", () => {
  assert.deepEqual(parseV4VisibleSlashCommand("/goal 修复登录"), {
    kind: "sendGoalCommand",
    objective: "修复登录",
    displayText: "/goal 修复登录",
  });
});

test("句中 /goal 命中，前文丢弃、目标取 token 之后到末尾", () => {
  // 取自真实会话 sess_3cdb9e16 / sess_0dc42fe5 的原文。
  assert.deepEqual(
    parseV4VisibleSlashCommand(
      "就算游戏能跑起来，我们也不能认为这种画质是正常的吧。 /goal 完善 DirectX 支持，使游戏能正常渲染和操作",
    ),
    {
      kind: "sendGoalCommand",
      objective: "完善 DirectX 支持，使游戏能正常渲染和操作",
      displayText:
        "就算游戏能跑起来，我们也不能认为这种画质是正常的吧。 /goal 完善 DirectX 支持，使游戏能正常渲染和操作",
    },
  );
});

test("句中 /goal 命中后，目标一直取到末尾（含后续句子）", () => {
  const text = "前面有话 /goal 修复登录 另外把 README 也改了";
  const parsed = parseV4VisibleSlashCommand(text);
  assert.equal(parsed?.kind, "sendGoalCommand");
  assert.equal(
    parsed?.kind === "sendGoalCommand" ? parsed.objective : null,
    "修复登录 另外把 README 也改了",
  );
});

test("结尾多余 /goal 不再让句中的 goal 一起失效", () => {
  // sess_0dc42fe5 段 148：开头和结尾各有一个 /goal。
  const text = "？我再强调一遍，一定是你的问题 /goal 不要再糊弄我了 /goal";
  const parsed = parseV4VisibleSlashCommand(text);
  assert.equal(parsed?.kind, "sendGoalCommand");
  assert.equal(
    parsed?.kind === "sendGoalCommand" ? parsed.objective : null,
    "不要再糊弄我了 /goal",
  );
});

test("/goal 后必须跟空白，紧贴中文不命中", () => {
  // sess_7f1cbe09 段 87：/goal3 会被整体当成命令名。
  assert.equal(parseV4VisibleSlashCommand("/goal3首先重点解决道路资产问题"), null);
  assert.equal(parseV4VisibleSlashCommand("前面有话 /goal3首先解决"), null);
});

test("前面不是空白的字符不触发句中命中", () => {
  assert.equal(parseV4VisibleSlashCommand("前缀/goal 修复登录"), null);
  assert.deepEqual(parseV4VisibleSlashCommand("邮箱a@b.com /goal 修复"), {
    kind: "sendGoalCommand",
    objective: "修复",
    displayText: "邮箱a@b.com /goal 修复",
  });
});

test("/plan 不参与句中命中，带前文时按普通文本下发", () => {
  assert.equal(parseV4VisibleSlashCommand("前面有话 /plan 切到计划模式"), null);
  assert.equal(parseV4VisibleSlashCommand("/plan 切到计划模式")?.kind, "planShortcut");
});

test("其他 CLI catalog 命令不因句中命中被误判为 goal", () => {
  assert.equal(parseV4VisibleSlashCommand("前面有话 /compact 一下"), null);
  assert.equal(parseV4VisibleSlashCommand("/compact 一下")?.kind, "compact");
});

test("控制命令在句中命中时语义与顶格一致", () => {
  assert.equal(parseV4VisibleSlashCommand("前面有话 /goal resume")?.kind, "resumeGoal");
  assert.equal(parseV4VisibleSlashCommand("前面有话 /goal pause")?.kind, "unsupportedGoal");
  assert.equal(parseV4VisibleSlashCommand("前面有话 /goal")?.kind, "emptyGoal");
});

test("replace 前缀在句中命中时同样剥除", () => {
  const parsed = parseV4VisibleSlashCommand("前面有话 /goal replace 新的目标");
  assert.equal(parsed?.kind === "sendGoalCommand" ? parsed.objective : null, "新的目标");
});

test("附件或上下文存在时拦住，不再静默当普通文本", () => {
  assert.deepEqual(parseV4VisibleSlashCommand("前面有话 /goal 修复登录", [{ id: "a" }]), {
    kind: "unsupportedGoalAttachments",
    displayText: "前面有话 /goal 修复登录",
  });
  assert.deepEqual(
    parseV4VisibleSlashCommand("前面有话 /goal 修复登录", [], { contextAttachmentCount: 1 }),
    {
      kind: "unsupportedGoalAttachments",
      displayText: "前面有话 /goal 修复登录",
    },
  );
});

test("中文句号后无空格的 /goal 仍消费为目标", () => {
  assert.deepEqual(parseV4VisibleSlashCommand("关系。/goal 一直分析，分析到你能理解为止"), {
    kind: "sendGoalCommand",
    objective: "一直分析，分析到你能理解为止",
    displayText: "关系。/goal 一直分析，分析到你能理解为止",
  });
});

test("队列恢复补前缀不会产出 /goal 前面有话 /goal …", () => {
  assert.equal(
    v4QueuedCommandText("sendGoalCommand", "前面有话 /goal 修复登录"),
    "前面有话 /goal 修复登录",
  );
  assert.equal(v4QueuedCommandText("sendGoalCommand", "修复登录"), "/goal 修复登录");
  assert.equal(
    v4QueuedCommandText("sendText", "前面有话 /goal 修复登录"),
    "前面有话 /goal 修复登录",
  );
});
