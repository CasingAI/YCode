import assert from "node:assert/strict";
import test from "node:test";
import type {
  BackgroundWorkSummary,
  V4ConversationSessionStorageResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  backgroundWorkStatuses,
  findCompletedBackgroundWorkIds,
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

test("warning requires a complete scan strictly above 50 MiB and no dismissal", () => {
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
