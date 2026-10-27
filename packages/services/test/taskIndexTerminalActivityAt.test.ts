import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import {
  createZCodeTaskIndexSyncer,
  resolveTerminalActivityAt,
} from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import type { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

test("终态活动版本只取 sessions-index lastActivityAt，且仅随 unreadSignal 携带", () => {
  assert.equal(resolveTerminalActivityAt({ lastActivityAt: 1_234 }, "background_terminal"), 1_234);
  assert.equal(resolveTerminalActivityAt({ lastActivityAt: 1_234 }, undefined), undefined);
  for (const invalid of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      resolveTerminalActivityAt({ lastActivityAt: invalid }, "background_terminal"),
      undefined,
      `非法活动版本 ${String(invalid)} 必须视为缺省`,
    );
  }
});

test("workspace_task_list_changed 透传 terminalActivityAt，普通收敛不携带", () => {
  const syncer = createZCodeTaskIndexSyncer({
    agentService: {} as IZCodeAgentService,
    taskIndexRepo: {} as TaskIndexRepo,
  });
  const events: ZCodeWorkspaceEvent[] = [];
  const subscription = syncer.onDynamicWorkspaceEvent("/example/workspace")((event) =>
    events.push(event),
  );
  try {
    syncer.emitWorkspaceTaskListChanged(
      { workspacePath: "/example/workspace", taskId: "task-terminal" },
      undefined,
      "task_status_changed",
      { unreadSignal: "background_terminal", terminalActivityAt: 9_000 },
    );
    syncer.emitWorkspaceTaskListChanged(
      { workspacePath: "/example/workspace", taskId: "task-terminal" },
      undefined,
      "task_status_changed",
    );

    assert.equal(events.length, 2);
    assert.deepEqual(
      {
        reason: events[0]?.type === "workspace_task_list_changed" ? events[0].reason : undefined,
        unreadSignal:
          events[0]?.type === "workspace_task_list_changed" ? events[0].unreadSignal : undefined,
        terminalActivityAt:
          events[0]?.type === "workspace_task_list_changed"
            ? events[0].terminalActivityAt
            : undefined,
      },
      {
        reason: "task_status_changed",
        unreadSignal: "background_terminal",
        terminalActivityAt: 9_000,
      },
    );
    assert.equal(
      events[1]?.type === "workspace_task_list_changed" ? events[1].terminalActivityAt : "missing",
      undefined,
      "普通 status 收敛不得携带终态版本",
    );
  } finally {
    subscription.dispose();
    syncer.disposeAll();
  }
});
