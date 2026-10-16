import assert from "node:assert/strict";
import test from "node:test";
import { filterAutomationsByStatus } from "../src/settings/automationStatusFilter.ts";

test("missed delay automation is included in the failed status filter", () => {
  const missed = {
    lifecycleStatus: "missed" as const,
    enabled: false,
    scheduleType: "delay" as const,
  };
  assert.deepEqual(filterAutomationsByStatus([missed], "failed"), [missed]);
  assert.deepEqual(filterAutomationsByStatus([missed], "inProgress"), []);
});
