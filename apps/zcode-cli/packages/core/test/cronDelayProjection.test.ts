import assert from "node:assert/strict";
import test from "node:test";
import type { CronAutomation } from "@zcode/contracts";
import { toModelAutomation } from "../src/tool/handlers/cron.js";

test("Cron tool output preserves delay classification and duration", () => {
  const automation: CronAutomation = {
    automationId: "automation-delay",
    scheduleType: "delay",
    delayMinutes: 120,
    title: "两小时后提醒",
    cronExpr: "0 12 1 1 *",
    prompt: "提醒一次",
    enabled: true,
    lifecycleStatus: "active",
    runCount: 0,
    recurring: false,
    mode: "team",
  };

  const projected = toModelAutomation(automation);
  assert.equal(projected.scheduleType, "delay");
  assert.equal(projected.delayMinutes, 120);
  assert.equal(projected.lifecycleStatus, "active");
  // CronList / CronCreate 输出必须回显 Team，不能丢失任务档位。
  assert.equal(projected.mode, "team");
});
