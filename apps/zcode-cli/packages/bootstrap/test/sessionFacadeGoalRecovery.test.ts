import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGoal } from "@zcode/contracts";
import { createSessionFacade } from "../src/app/session-facade.js";

// 活会话 readTarget 是只读投影。刚提交的 Goal 合法形态就是 active 且没有
// run 租约；若在这里走 orphan/interrupted 收口，气泡已经出现、自主循环却
// 永远不会开始。崩溃残留的收口只发生在会话恢复（resume.ts）。

const SESSION_ID = "session-facade-recovery" as never;
const BASE_TIME = 1_700_000_000_000;

function buildGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: SESSION_ID,
    targetID: "target-1",
    objective: "把登录页修好",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: BASE_TIME, updated: BASE_TIME },
    ...overrides,
  };
}

function createFacade(options: { goal: SessionGoal | null; activeTurn: boolean }) {
  const calls: string[] = [];
  const readTarget = options.goal;
  const sessionStore = {
    readTarget: async () => readTarget,
    recoverInterruptedTargetRun: async () => {
      calls.push("recoverInterruptedTargetRun");
      return buildGoal({ status: "paused" });
    },
    recoverOrphanedActiveTarget: async () => {
      calls.push("recoverOrphanedActiveTarget");
      return buildGoal({ status: "paused" });
    },
  };
  const facade = createSessionFacade({
    sessionId: SESSION_ID,
    sessionStore,
    runtime: {
      getActiveTurnInfo: () => (options.activeTurn ? { turnId: "turn-1" } : null),
      getSessionModelSelection: () => undefined,
    },
    // 下面这些与 readTarget 分支无关，只为满足 deps 形状。
    configResult: { config: { ui: { locale: "en-US" } } },
    configuredMcpServers: {},
    executionPort: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    loggerFactory: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    ownsExecutionPort: false,
    ownsMcpPort: false,
    ownsSessionStore: false,
    prepareUserExecutionBoundary: async () => {},
    prepareResume: async () => {},
    projectID: "project-1" as never,
    providerRegistry: { getProvider: () => undefined },
    resolveUiLocale: () => "en-US" as never,
    traceContext: { queryId: "query-1" },
    untrustedProjectMcpServers: new Set(),
    workingDirectory: "/tmp/workspace",
  } as never);
  return { facade, calls };
}

test("刚提交、尚无 run 租约的 Goal：活会话读取保持 active，不走 orphan 收口", async () => {
  const { facade, calls } = createFacade({ goal: buildGoal(), activeTurn: false });

  const target = await facade.readTarget();

  assert.deepEqual(calls, []);
  assert.equal(target?.status, "active");
});

test("上次进程留下的 active run：活会话读取也不收口，留给会话恢复", async () => {
  const { facade, calls } = createFacade({
    goal: buildGoal({ activeInputId: "input-1", activeRunStartedAtMs: BASE_TIME }),
    activeTurn: false,
  });

  const target = await facade.readTarget();

  assert.deepEqual(calls, []);
  assert.equal(target?.status, "active");
});

test("当前有活跃 turn：读取原样返回", async () => {
  const { facade, calls } = createFacade({
    goal: buildGoal({ activeInputId: "input-1", activeRunStartedAtMs: BASE_TIME }),
    activeTurn: true,
  });

  const target = await facade.readTarget();

  assert.deepEqual(calls, []);
  assert.equal(target?.status, "active");
});

test("goal 已经 paused：原样返回", async () => {
  const { facade, calls } = createFacade({
    goal: buildGoal({ status: "paused" }),
    activeTurn: false,
  });

  const target = await facade.readTarget();

  assert.deepEqual(calls, []);
  assert.equal(target?.status, "paused");
});

test("没有 goal：返回 null，不触发任何恢复", async () => {
  const { facade, calls } = createFacade({ goal: null, activeTurn: false });

  assert.equal(await facade.readTarget(), null);
  assert.deepEqual(calls, []);
});
