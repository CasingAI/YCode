import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import {
  groupTrajectoryInputRows,
  trajectoryRoleLabelId,
  trajectoryWireRoleMismatch,
} from "../src/ModelTrajectoryMessageOrigin.js";

// 轨迹角色标签与输入区分组（docs/specs/model-trajectory-message-origin.md）：
// 运行时注入 reminder 用专用标签；系统提示词独立成块；reminder 内嵌到所属用户回合。

function message(overrides: Partial<ZCodeModelTrajectoryMessage>): ZCodeModelTrajectoryMessage {
  return { role: "user", parts: [], ...overrides };
}

test("system-reminder 返回专用标签 key，其余沿用 role 标签", () => {
  // 线上是独立 system 消息的注入 → 「系统消息（运行时注入）」。
  assert.equal(
    trajectoryRoleLabelId(
      message({ role: "system", origin: "system-reminder", wireRole: "system" }),
    ),
    "modelTrajectory.role.systemInjected",
  );
  // 寄生在 user 消息里的注入（含线上角色未确认的）→ 「System reminder」。
  assert.equal(
    trajectoryRoleLabelId(message({ role: "user", origin: "system-reminder" })),
    "modelTrajectory.role.systemReminder",
  );
  assert.equal(
    trajectoryRoleLabelId(message({ role: "system", origin: "system-reminder" })),
    "modelTrajectory.role.systemReminder",
  );
  assert.equal(
    trajectoryRoleLabelId(message({ role: "system", origin: "system-prompt" })),
    "modelTrajectory.role.system",
  );
  assert.equal(
    trajectoryRoleLabelId(message({ role: "assistant" })),
    "modelTrajectory.role.assistant",
  );
});

test("wireRole 缺省或与消息 role 一致时不展示线上角色徽标", () => {
  assert.equal(trajectoryWireRoleMismatch(message({ origin: "system-reminder" })), null);
  assert.equal(
    trajectoryWireRoleMismatch(message({ origin: "system-reminder", wireRole: "user" })),
    null,
  );
});

test("线上角色与 SDK 视图 role 不一致时返回徽标参数", () => {
  assert.deepEqual(
    trajectoryWireRoleMismatch(message({ origin: "system-reminder", wireRole: "system" })),
    {
      wireRole: "system",
    },
  );
});

test("非 reminder 消息不展示线上角色徽标", () => {
  assert.equal(trajectoryWireRoleMismatch(message({ wireRole: "user" })), null);
  assert.equal(
    trajectoryWireRoleMismatch(message({ origin: "system-prompt", wireRole: "user" })),
    null,
  );
});

// ---- 输入区分组 ----

function reminder(overrides: Partial<ZCodeModelTrajectoryMessage> = {}) {
  return message({ origin: "system-reminder", ...overrides });
}

test("前导 system-prompt 提出为独立区块，置于对话消息之前", () => {
  const rows = groupTrajectoryInputRows([
    message({ role: "system", origin: "system-prompt" }),
    message({ role: "system", origin: "system-prompt" }),
    message({ origin: "conversation" }),
    message({ role: "assistant", origin: "conversation" }),
  ]);

  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.kind, "system-prompt");
  if (rows[0]?.kind === "system-prompt") assert.equal(rows[0].messages.length, 2);
  // 单条真实 user 消息也是用户回合（无内嵌 reminder）。
  assert.equal(rows[1]?.kind, "user-turn");
  assert.equal(rows[2]?.kind, "message");
});

test("连续 user-role 消息归为一个用户回合，reminder 内嵌主消息", () => {
  const context = reminder();
  const primary = message({ origin: "conversation" });
  const skills = reminder();
  const rows = groupTrajectoryInputRows([
    context,
    primary,
    skills,
    message({ role: "assistant", origin: "conversation" }),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { kind: "user-turn", primary, reminders: [context, skills] });
  assert.equal(rows[1]?.kind, "message");
});

test("wireRole 为 system 的 reminder 保持独立行，不内嵌", () => {
  const standalone = reminder({ role: "system", wireRole: "system" });
  const primary = message({ origin: "conversation" });
  const merged = reminder();

  // system 角色的 reminder 会断开 user 连续组；它出现在 user 回合之后。
  const rows = groupTrajectoryInputRows([primary, merged, standalone]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { kind: "user-turn", primary, reminders: [merged] });
  assert.deepEqual(rows[1], { kind: "message", message: standalone });
});

test("user 回合组内没有真实 user 消息时，reminder 保持独立行", () => {
  const alone = reminder();
  const rows = groupTrajectoryInputRows([
    message({ role: "assistant", origin: "conversation" }),
    alone,
    message({ role: "assistant", origin: "conversation" }),
  ]);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { kind: "message", message: alone });
});

test("无系统提示词与用户消息时保持原消息行（旧记录兼容）", () => {
  const assistant = message({ role: "assistant", origin: "conversation" });
  const tool = message({ role: "tool", origin: "conversation" });
  const rows = groupTrajectoryInputRows([assistant, tool]);

  assert.deepEqual(rows, [
    { kind: "message", message: assistant },
    { kind: "message", message: tool },
  ]);
});
