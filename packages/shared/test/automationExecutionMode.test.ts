import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATION_DEFAULT_WRITABLE_MODE,
  AUTOMATION_WRITABLE_MODES,
  isAutomationWritableMode,
} from "../src/automation-types.js";
import {
  zcodeAutomationCreateParamsSchema,
  zcodeAutomationProtocolSchema,
  zcodeAutomationUpdateParamsSchema,
  zcodeOffPeakCreateParamsSchema,
  zcodeOffPeakPermissionModeSchema,
  zcodeOffPeakTaskSnapshotSchema,
} from "../src/zcode-protocol/index.js";
import { hostCronRunMessageSchema, hostOffPeakRunMessageSchema } from "../src/validation.js";

const baseAutomation = {
  automationId: "automation-1",
  title: "每20分钟喝水提醒",
  cronExpr: "*/20 * * * *",
  prompt: "提醒我喝水",
  enabled: true,
  lifecycleStatus: "active",
  scheduleType: "scheduled",
  runCount: 0,
  recurring: true,
} as const;

test("自动化可写档位只包含 Agent 与 Team，默认值为 Agent", () => {
  assert.deepEqual(AUTOMATION_WRITABLE_MODES, ["yolo", "team"]);
  assert.equal(AUTOMATION_DEFAULT_WRITABLE_MODE, "yolo");
  assert.equal(isAutomationWritableMode("yolo"), true);
  assert.equal(isAutomationWritableMode("team"), true);
  assert.equal(isAutomationWritableMode("plan"), false);
  assert.equal(isAutomationWritableMode("readonly"), false);
  assert.equal(isAutomationWritableMode(null), false);
});

test("创建协议接受 yolo/team 与省略，拒绝 Ask/Plan 和 null", () => {
  const base = {
    cronExpr: "* * * * *",
    prompt: "执行任务",
  };
  assert.equal(zcodeAutomationCreateParamsSchema.safeParse(base).success, true);
  assert.equal(zcodeAutomationCreateParamsSchema.parse({ ...base, mode: "yolo" }).mode, "yolo");
  assert.equal(zcodeAutomationCreateParamsSchema.parse({ ...base, mode: "team" }).mode, "team");
  assert.equal(
    zcodeAutomationCreateParamsSchema.safeParse({ ...base, mode: "plan" }).success,
    false,
  );
  assert.equal(
    zcodeAutomationCreateParamsSchema.safeParse({ ...base, mode: "readonly" }).success,
    false,
  );
  assert.equal(zcodeAutomationCreateParamsSchema.safeParse({ ...base, mode: null }).success, false);
});

test("更新协议省略档位保留语义，显式 Team 可切换，历史 null 不再可写", () => {
  const base = { automationId: "automation-1", title: "新标题" };
  const omitted = zcodeAutomationUpdateParamsSchema.parse(base);
  assert.equal(omitted.mode, undefined);
  assert.equal(zcodeAutomationUpdateParamsSchema.parse({ ...base, mode: "team" }).mode, "team");
  assert.equal(
    zcodeAutomationUpdateParamsSchema.safeParse({ ...base, mode: "plan" }).success,
    false,
  );
  assert.equal(zcodeAutomationUpdateParamsSchema.safeParse({ ...base, mode: null }).success, false);
  // at-least-one 校验必须把 mode 计入有效更新字段。
  assert.equal(
    zcodeAutomationUpdateParamsSchema.safeParse({ ...base, mode: "yolo" }).success,
    true,
  );
});

test("读取协议保留历史旧档位，列表不丢失 Team", () => {
  assert.equal(zcodeAutomationProtocolSchema.parse(baseAutomation).mode, undefined);
  assert.equal(
    zcodeAutomationProtocolSchema.parse({ ...baseAutomation, mode: "team" }).mode,
    "team",
  );
  assert.equal(
    zcodeAutomationProtocolSchema.parse({ ...baseAutomation, mode: "plan" }).mode,
    "plan",
  );
});

test("闲时任务协议接受 Agent/Team，snapshot 保留 Team 并兼容旧值", () => {
  assert.equal(zcodeOffPeakPermissionModeSchema.parse("team"), "team");
  assert.equal(zcodeOffPeakPermissionModeSchema.safeParse("plan").success, false);
  const base = { title: "闲时重构", prompt: "重构 utils" };
  assert.equal(zcodeOffPeakCreateParamsSchema.parse(base).permissionMode, undefined);
  assert.equal(
    zcodeOffPeakCreateParamsSchema.parse({ ...base, permissionMode: "team" }).permissionMode,
    "team",
  );
  assert.equal(
    zcodeOffPeakCreateParamsSchema.safeParse({ ...base, permissionMode: "plan" }).success,
    false,
  );

  const snapshot = {
    offPeakTaskId: "offpeak-1",
    title: "闲时重构",
    status: "queued",
    createdAt: 1,
  } as const;
  assert.equal(
    zcodeOffPeakTaskSnapshotSchema.parse({ ...snapshot, permissionMode: "team" }).permissionMode,
    "team",
  );
  assert.equal(
    zcodeOffPeakTaskSnapshotSchema.parse({ ...snapshot, permissionMode: "plan" }).permissionMode,
    "plan",
  );
  // 旧 Host 不回传 permissionMode 时仍可解析，避免升级期列表整体失败。
  assert.equal(zcodeOffPeakTaskSnapshotSchema.parse(snapshot).permissionMode, undefined);
});

test("Host 派发消息按宽松 string 传递 Team 档位", () => {
  const cronRun = hostCronRunMessageSchema.parse({
    type: "cron-run",
    automationId: "automation-1",
    runId: "run-1",
    dispatchId: "dispatch-1",
    workspacePath: "C:/workspace",
    prompt: "执行",
    mode: "team",
  });
  assert.equal(cronRun.mode, "team");

  const offPeakRun = hostOffPeakRunMessageSchema.parse({
    type: "off-peak-run",
    offPeakTaskId: "offpeak-1",
    workspacePath: "C:/workspace",
    prompt: "执行",
    permissionMode: "team",
    modelSelection: { providerId: "provider-1", modelId: "model-1" },
  });
  assert.equal(offPeakRun.permissionMode, "team");
});
