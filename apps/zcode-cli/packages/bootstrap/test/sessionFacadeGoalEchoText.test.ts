import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGoal } from "@zcode/contracts";
import { createSessionFacade } from "../src/app/session-facade.js";

// goal 行落库形态契约（goal-command-scope-and-decoration.md「落库形态」）：
// sendGoalCommand 行的可见文本必含命令 token。这里是唯一落库口
// （setTargetStatus("set") → recordExternalUserPrompt）的单测：displayText
// 缺省/空白时构造 `/goal <objective>`，任何调用路径（编辑重发、retry、旧协议）
// 不传 token 也不再落裸 objective——否则 commandKind 判成 goal、气泡却画不出
// 芯片（「目标设置成功但标志消失」）。

const SESSION_ID = "session-facade-goal-echo" as never;
const BASE_TIME = 1_700_000_000_000;

function buildGoal(objective: string): SessionGoal {
  return {
    sessionID: SESSION_ID,
    targetID: "target-1",
    objective,
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: BASE_TIME, updated: BASE_TIME },
  };
}

function createFacade() {
  const externalPrompts: string[] = [];
  const facade = createSessionFacade({
    sessionId: SESSION_ID,
    sessionStore: {
      readTarget: async () => null,
      setTarget: async (input: { objective: string }) => buildGoal(input.objective),
    },
    runtime: {
      ensureSessionPersistedForExternalActivity: async () => {},
      recordExternalUserPrompt: async (text: string) => {
        externalPrompts.push(text);
      },
      recordTargetChanged: async () => {},
      getSessionModelSelection: () => undefined,
    },
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
  return { facade, externalPrompts };
}

test("缺省 displayText：落库可见文本构造为 /goal <objective>，不落裸 objective", async () => {
  const { facade, externalPrompts } = createFacade();

  await facade.setTarget({ objective: "把登录页修好", status: "active" });

  assert.deepEqual(externalPrompts, ["/goal 把登录页修好"]);
});

test("displayText 原文透传：协议层提交的原文（含 target 别名与前文）逐字保留", async () => {
  const { facade, externalPrompts } = createFacade();

  await facade.setTarget({
    objective: "把登录页修好",
    displayText: "先看下日志 /target 把登录页修好",
    status: "active",
  });

  assert.deepEqual(externalPrompts, ["先看下日志 /target 把登录页修好"]);
});

test("displayText 空白：与缺省同构，构造 /goal 前缀", async () => {
  const { facade, externalPrompts } = createFacade();

  await facade.setTarget({ objective: "修复登录", displayText: "   ", status: "active" });

  assert.deepEqual(externalPrompts, ["/goal 修复登录"]);
});
