import assert from "node:assert/strict";
import test from "node:test";
import {
  goalCommandChipPayload,
  splitGoalCommandToken,
} from "../src/mentions/goalCommandPrefill.js";

// 编辑卡预填的 goal token 切分（docs/specs/goal-command-scope-and-decoration.md
// 「编辑卡预填形态」）。边界正则与发送端同源（@zcode/shared goal-command-token），
// 这里只验证切分形状与芯片载荷约定。

test("顶格 token：before 为空，after 保留原文（含前导空格）", () => {
  assert.deepEqual(splitGoalCommandToken("/goal 完成计划"), {
    before: "",
    token: "/goal",
    commandName: "goal",
    after: " 完成计划",
  });
});

test("句中 token 带前文", () => {
  assert.deepEqual(splitGoalCommandToken("先说一句 /goal 目标正文"), {
    before: "先说一句 ",
    token: "/goal",
    commandName: "goal",
    after: " 目标正文",
  });
});

test("/target 同样命中", () => {
  const split = splitGoalCommandToken("/target 另一个目标");
  assert.ok(split);
  assert.equal(split.commandName, "target");
  assert.equal(split.token, "/target");
});

test("大小写：token 保留原文切片，commandName 归一小写", () => {
  const split = splitGoalCommandToken("/GOAL 大写目标");
  assert.ok(split);
  assert.equal(split.token, "/GOAL");
  assert.equal(split.commandName, "goal");
});

test("无 token 返回 null", () => {
  assert.equal(splitGoalCommandToken("普通消息，没有命令"), null);
});

test("汉字紧贴前缀不算 token（前缀/goal）", () => {
  assert.equal(splitGoalCommandToken("前缀/goal 目标"), null);
});

test("token 后无正文（行尾）", () => {
  const split = splitGoalCommandToken("/goal");
  assert.ok(split);
  assert.equal(split.after, "");
});

test("只切首个 token，其余出现留在 after", () => {
  const split = splitGoalCommandToken("/goal a /goal b");
  assert.ok(split);
  assert.equal(split.after, " a /goal b");
});

test("芯片载荷：prefill-slash id + 小写 value + 原始 markdown", () => {
  const payload = goalCommandChipPayload({
    before: "",
    token: "/Goal",
    commandName: "goal",
    after: " x",
  });
  assert.deepEqual(payload, {
    id: "prefill-slash:goal",
    category: "commands",
    label: "goal",
    value: "goal",
    markdown: "/Goal",
    description: "",
  });
});
