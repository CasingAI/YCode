import assert from "node:assert/strict";
import test from "node:test";
import { CronUpdateInputSchema, CronAutomationSchema } from "@zcode/contracts/tools";
import { zcodeAutomationProtocolSchema } from "@zcode/shared";

const cronAutomation = {
  automationId: "automation-1",
  title: "延时任务",
  cronExpr: "* * * * *",
  prompt: "执行一次",
  enabled: false,
  lifecycleStatus: "missed" as const,
  scheduleType: "delay" as const,
  delayMinutes: 120,
  runCount: 0,
  recurring: false,
};

test("Automation protocol and CronAutomation accept delay and missed lifecycle", () => {
  const protocolAutomation = {
    ...cronAutomation,
  };
  assert.equal(zcodeAutomationProtocolSchema.safeParse(protocolAutomation).success, true);
  assert.equal(CronAutomationSchema.safeParse(cronAutomation).success, true);
});

test("CronUpdate accepts an explicit delay duration", () => {
  assert.equal(
    CronUpdateInputSchema.safeParse({ id: "automation-1", title: "延时任务", delayMinutes: 120 })
      .success,
    true,
  );
});

test("CronUpdate rejects delay values outside the supported integer range", () => {
  for (const delayMinutes of [0, -1, 1.5, 525_601]) {
    assert.equal(
      CronUpdateInputSchema.safeParse({ id: "automation-1", title: "延时任务", delayMinutes })
        .success,
      false,
      `delayMinutes=${delayMinutes}`,
    );
  }
});

test("CronUpdate rejects combining a delay with calendar or recurring fields", () => {
  assert.equal(
    CronUpdateInputSchema.safeParse({
      id: "automation-1",
      title: "延时任务",
      delayMinutes: 120,
      cron: "0 9 * * *",
    }).success,
    false,
  );
  assert.equal(
    CronUpdateInputSchema.safeParse({
      id: "automation-1",
      title: "延时任务",
      delayMinutes: 120,
      intervalUnit: "daily",
      interval: 1,
    }).success,
    false,
  );
});
