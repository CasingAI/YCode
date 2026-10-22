import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROLLER_WINDOW_WORKSPACES_TOPIC,
  type WindowHostControllerWindowWorkspacesFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { createWindowHostControllerProjection } from "../src/host/windowHostControllerProjection.js";

function createProjection() {
  let counter = 0;
  return createWindowHostControllerProjection({
    createId: () => `id-${(counter += 1)}`,
  });
}

function windowWorkspacesReport(clientRevision: number) {
  return {
    clientRevision,
    entries: [
      {
        id: "tab-1",
        workspacePath: "/repo/alpha",
        activeTaskId: "task-1",
      },
    ],
    activeEntryId: "tab-1",
    activeWorkspacePath: "/repo/alpha",
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: ["/repo/alpha"],
  };
}

test("新订阅 window-workspaces topic 的客户端立即拿到全量快照", () => {
  const projection = createProjection();
  const frames: WindowHostControllerWindowWorkspacesFrame[] = [];
  const subscription = projection.subscribe({
    topic: CONTROLLER_WINDOW_WORKSPACES_TOPIC,
    onFrame: (frame) => frames.push(frame as WindowHostControllerWindowWorkspacesFrame),
  });

  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.payload.kind, "snapshot");
  assert.equal(frames[0]!.topic, CONTROLLER_WINDOW_WORKSPACES_TOPIC);
  subscription.dispose();
});

test("接受更大 clientRevision 的上报后发布替换帧并递增 revision", () => {
  const projection = createProjection();
  const frames: WindowHostControllerWindowWorkspacesFrame[] = [];
  projection.subscribe({
    topic: CONTROLLER_WINDOW_WORKSPACES_TOPIC,
    onFrame: (frame) => frames.push(frame as WindowHostControllerWindowWorkspacesFrame),
  });

  const accepted = projection.reportWindowWorkspaces(windowWorkspacesReport(1));
  assert.equal(accepted.revision, 1);
  assert.equal(frames.length, 2);
  const delta = frames[1]!;
  assert.equal(delta.payload.kind, "deltas");
  assert.equal(delta.payload.kind === "deltas" && delta.payload.deltas[0]!.op, "window-workspaces.replaced");
  const replaced =
    delta.payload.kind === "deltas" ? delta.payload.deltas[0]! : undefined;
  assert.equal(replaced?.op === "window-workspaces.replaced" && replaced.windowWorkspaces.entries.length, 1);
  assert.equal(
    replaced?.op === "window-workspaces.replaced" &&
      replaced.windowWorkspaces.entries[0]!.activeTaskId,
    "task-1",
  );
});

test("重复或乱序的 clientRevision 上报被丢弃且不产生新帧", () => {
  const projection = createProjection();
  const frames: WindowHostControllerWindowWorkspacesFrame[] = [];
  projection.subscribe({
    topic: CONTROLLER_WINDOW_WORKSPACES_TOPIC,
    onFrame: (frame) => frames.push(frame as WindowHostControllerWindowWorkspacesFrame),
  });

  projection.reportWindowWorkspaces(windowWorkspacesReport(5));
  const frameCount = frames.length;
  const revision = projection.reportWindowWorkspaces(windowWorkspacesReport(5));
  assert.equal(revision.revision, 1);
  assert.equal(frames.length, frameCount);

  const stale = projection.reportWindowWorkspaces(windowWorkspacesReport(3));
  assert.equal(stale.revision, 1);
  assert.equal(frames.length, frameCount);
});

test("后加入的订阅者拿到的是最新一次上报的快照", () => {
  const projection = createProjection();
  projection.reportWindowWorkspaces(windowWorkspacesReport(1));

  const frames: WindowHostControllerWindowWorkspacesFrame[] = [];
  projection.subscribe({
    topic: CONTROLLER_WINDOW_WORKSPACES_TOPIC,
    onFrame: (frame) => frames.push(frame as WindowHostControllerWindowWorkspacesFrame),
  });

  assert.equal(frames.length, 1);
  const snapshot = frames[0]!.payload;
  assert.equal(snapshot.kind, "snapshot");
  assert.equal(snapshot.kind === "snapshot" && snapshot.snapshot.windowWorkspaces.revision, 1);
  assert.equal(
    snapshot.kind === "snapshot" &&
      snapshot.snapshot.windowWorkspaces.entries[0]!.workspacePath,
    "/repo/alpha",
  );
});
