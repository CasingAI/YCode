import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  V4ConversationSessionStorageResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  backgroundWorkStatuses,
  findCompletedBackgroundWorkIds,
  isSessionStorageWarningEnabled,
  resolveSessionStorageManagementBlockReason,
  resolveSessionStorageWarningVisibility,
  shouldScanForSessionStorageWarning,
  SESSION_STORAGE_WARNING_THRESHOLD_BYTES,
  shouldShowSessionStorageWarning,
} from "../src/v4/sessionStorageWarningModel.js";

const usage = (
  overrides: Partial<V4ConversationSessionStorageResult> = {},
): V4ConversationSessionStorageResult => ({
  sessionId: "sess_1",
  totalBytes: SESSION_STORAGE_WARNING_THRESHOLD_BYTES,
  categories: [],
  complete: true,
  errorCount: 0,
  dismissed: false,
  ...overrides,
});

const backgroundWork = (
  workId: string,
  status: BackgroundWorkSummary["status"],
): BackgroundWorkSummary => ({
  workId,
  kind: "bash",
  title: workId,
  status,
  startedAt: 1,
  anchorRowId: null,
});

test("warning requires a complete scan strictly above 100 MiB and no dismissal", () => {
  assert.equal(shouldShowSessionStorageWarning(usage()), false);
  assert.equal(
    shouldShowSessionStorageWarning(
      usage({ totalBytes: SESSION_STORAGE_WARNING_THRESHOLD_BYTES + 1 }),
    ),
    true,
  );
  assert.equal(
    shouldShowSessionStorageWarning(
      usage({ totalBytes: SESSION_STORAGE_WARNING_THRESHOLD_BYTES + 1, complete: false }),
    ),
    false,
  );
  assert.equal(
    shouldShowSessionStorageWarning(
      usage({ totalBytes: SESSION_STORAGE_WARNING_THRESHOLD_BYTES + 1, dismissed: true }),
    ),
    false,
  );
});

test("background scan triggers only for running work that ends or disappears", () => {
  const previous = backgroundWorkStatuses([
    backgroundWork("done", "running"),
    backgroundWork("removed", "running"),
    backgroundWork("still-running", "running"),
    backgroundWork("already-ended", "failed"),
  ]);
  const completed = findCompletedBackgroundWorkIds(previous, [
    backgroundWork("done", "resultPending"),
    backgroundWork("still-running", "running"),
  ]);

  assert.deepEqual(completed.sort(), ["done", "removed"]);
});

test("automatic scans run on terminal history and completed turns, but not draft or prewarming", () => {
  assert.equal(shouldScanForSessionStorageWarning("draft", "draft", true), false);
  assert.equal(shouldScanForSessionStorageWarning("prewarming", "prewarming", true), false);
  assert.equal(shouldScanForSessionStorageWarning("running", "running", false), false);
  assert.equal(shouldScanForSessionStorageWarning("running", "completedSuccess", false), true);
  assert.equal(
    shouldScanForSessionStorageWarning("prewarming", "completedInterrupted", false),
    false,
  );
  assert.equal(
    shouldScanForSessionStorageWarning("completedSuccess", "completedSuccess", true),
    true,
  );
});

test("storage management stays reachable for every client that connects to a capable host", () => {
  // Web 与手机远控同样连接宿主的管理服务，不能因为不是 Desktop 就禁用入口。
  assert.equal(
    resolveSessionStorageManagementBlockReason({
      hasStorageCapability: true,
      isRemoteWorkspaceSession: false,
    }),
    null,
  );
});

test("storage management is blocked when the host has no storage capability", () => {
  assert.equal(
    resolveSessionStorageManagementBlockReason({
      hasStorageCapability: false,
      isRemoteWorkspaceSession: false,
    }),
    "noStorageCapability",
  );
});

test("storage management is blocked when the session runs on a remote workspace host", () => {
  assert.equal(
    resolveSessionStorageManagementBlockReason({
      hasStorageCapability: true,
      isRemoteWorkspaceSession: true,
    }),
    "remoteWorkspaceSession",
  );
  assert.equal(
    resolveSessionStorageManagementBlockReason({
      hasStorageCapability: false,
      isRemoteWorkspaceSession: true,
    }),
    "noStorageCapability",
  );
});

test("提示开关缺省视为开启，显式关闭才不提示", () => {
  assert.equal(isSessionStorageWarningEnabled(null), true);
  assert.equal(isSessionStorageWarningEnabled(undefined), true);
  assert.equal(isSessionStorageWarningEnabled({} as AppSettings), true);
  assert.equal(
    isSessionStorageWarningEnabled({ sessionStorageWarningEnabled: true } as AppSettings),
    true,
  );
  assert.equal(
    isSessionStorageWarningEnabled({ sessionStorageWarningEnabled: false } as AppSettings),
    false,
  );
});

test("全局开关关闭时横幅不可见，与阈值和按会话关闭状态无关", () => {
  const overThreshold = usage({
    totalBytes: SESSION_STORAGE_WARNING_THRESHOLD_BYTES + 1,
  });
  assert.equal(
    resolveSessionStorageWarningVisibility({
      usage: overThreshold,
      dismissed: false,
      enabled: false,
    }),
    false,
  );
  assert.equal(
    resolveSessionStorageWarningVisibility({
      usage: overThreshold,
      dismissed: false,
      enabled: true,
    }),
    true,
  );
  assert.equal(
    resolveSessionStorageWarningVisibility({
      usage: overThreshold,
      dismissed: true,
      enabled: true,
    }),
    false,
  );
});
