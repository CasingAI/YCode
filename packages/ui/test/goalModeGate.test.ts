import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionPaneSource = readFileSync(
  new URL("../src/v4/SessionPane.tsx", import.meta.url),
  "utf8",
);

// 受限档与 Goal 互斥（docs/specs/agent-mode-axis.md 验收 7a）。Goal 的自主循环
// 必须落盘，Plan / Ask 都跑不动：发送入口一律 toast 拦下、草稿保留、档位不动，
// 要发 Goal 得用户自己先切到 Agent。

// 取出发送路径上的 Goal 档位门禁整段，避免只断言某一行而漏掉分支。
const goalModeGate = (() => {
  const start = sessionPaneSource.indexOf("submission !== null &&");
  assert.notEqual(start, -1, "找不到 Goal 档位门禁的 if 条件");
  const end = sessionPaneSource.indexOf("if (!submission) {", start);
  assert.notEqual(end, -1, "找不到 Goal 档位门禁的结束位置");
  return sessionPaneSource.slice(start, end);
})();

test("Goal 门禁覆盖设目标、恢复、空命令与暂不支持的控制词", () => {
  for (const kind of ["sendGoalCommand", "resumeGoal", "emptyGoal", "unsupportedGoal"]) {
    assert.match(goalModeGate, new RegExp(`slashCommand\\.kind === "${kind}"`));
  }
});

test("非 Agent 档位下 Goal 走既有提示并 blocked，不下发命令", () => {
  assert.match(goalModeGate, /submission\.mode !== "yolo"/);
  assert.match(goalModeGate, /chat\.goal\.readOnlyModeBlocked/);
  assert.match(goalModeGate, /chat\.goal\.planModeBlocked/);
  assert.match(goalModeGate, /return "blocked" as const/);
});

test("Goal 命令不再自行切到 Agent", () => {
  // 曾经在这里调 handleDraftSwitchMode("yolo") 并改写提交载荷，让 /goal 绕过模式轴。
  assert.equal(goalModeGate.includes('handleDraftSwitchMode("yolo")'), false);
  assert.equal(goalModeGate.includes('mode: "yolo"'), false);
});
