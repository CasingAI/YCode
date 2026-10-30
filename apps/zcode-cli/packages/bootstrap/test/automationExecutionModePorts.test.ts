import assert from "node:assert/strict";
import test from "node:test";
import { zcodeProtocolMethods } from "@zcode/shared";
import { createProtocolAutomationPort } from "../src/zcode-protocol/automation-port.js";
import { createProtocolOffPeakPort } from "../src/zcode-protocol/offpeak-port.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

interface CapturedCall {
  method: string;
  params: Record<string, unknown>;
}

function protocolAutomation(mode?: string) {
  return {
    automationId: "automation-1",
    title: "每20分钟提醒",
    cronExpr: "*/20 * * * *",
    prompt: "提醒我喝水",
    enabled: true,
    lifecycleStatus: "active" as const,
    scheduleType: "scheduled" as const,
    runCount: 0,
    recurring: true,
    ...(mode !== undefined ? { mode } : {}),
  };
}

function protocolOffPeakTask(permissionMode?: string) {
  return {
    offPeakTaskId: "offpeak-1",
    title: "闲时任务",
    status: "queued" as const,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    createdAt: 1,
  };
}

function createContext(
  calls: CapturedCall[],
  responses: Partial<Record<string, unknown>>,
): ZCodeProtocolAgentServerContext {
  return {
    sessions: new Map(),
    logger: { warn() {} },
    requestClient: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (!(method in responses)) throw new Error(`unexpected protocol method: ${method}`);
      return responses[method];
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("自动化端口创建默认落 Agent、显式 Team 透传", async () => {
  const calls: CapturedCall[] = [];
  const context = createContext(calls, {
    [zcodeProtocolMethods.automationCreate]: { automation: protocolAutomation("yolo") },
  });
  const port = createProtocolAutomationPort(context);

  await port.create({ title: "默认", prompt: "执行", cron: "* * * * *" });
  assert.equal(calls[0]?.params.mode, "yolo");

  calls.length = 0;
  const teamContext = createContext(calls, {
    [zcodeProtocolMethods.automationCreate]: { automation: protocolAutomation("team") },
  });
  const teamPort = createProtocolAutomationPort(teamContext);
  const created = await teamPort.create({
    title: "团队",
    prompt: "执行",
    cron: "* * * * *",
    mode: "team",
  });
  assert.equal(calls[0]?.params.mode, "team");
  assert.equal(created.mode, "team");
});

test("自动化端口更新省略 mode 时不提交，显式 Team 才透传", async () => {
  const calls: CapturedCall[] = [];
  const context = createContext(calls, {
    [zcodeProtocolMethods.automationUpdate]: { automation: protocolAutomation("team") },
  });
  const port = createProtocolAutomationPort(context);

  const preserved = await port.update({ id: "automation-1", title: "仅改标题" });
  assert.equal(Object.hasOwn(calls[0]?.params ?? {}, "mode"), false);
  assert.equal(preserved.mode, "team");

  calls.length = 0;
  const switched = await port.update({ id: "automation-1", title: "切换", mode: "team" });
  assert.equal(calls[0]?.params.mode, "team");
  assert.equal(switched.mode, "team");
});

test("自动化列表保留 Team，把历史 bare 归一为 Team，其它旧档位归一为 Agent", async () => {
  const context = createContext([], {
    [zcodeProtocolMethods.automationList]: {
      automations: [
        protocolAutomation("team"),
        protocolAutomation("bare"),
        protocolAutomation("plan"),
      ],
    },
  });
  const port = createProtocolAutomationPort(context);
  const automations = await port.list();
  assert.deepEqual(
    automations.map((automation) => automation.mode),
    ["team", "team", "yolo"],
  );
});

test("闲时任务端口创建透传 Team，列表不丢失 Team", async () => {
  const calls: CapturedCall[] = [];
  const context = createContext(calls, {
    [zcodeProtocolMethods.offPeakCreate]: {
      ok: true,
      task: protocolOffPeakTask("team"),
    },
    [zcodeProtocolMethods.offPeakList]: {
      tasks: [
        protocolOffPeakTask("team"),
        protocolOffPeakTask("bare"),
        protocolOffPeakTask("plan"),
      ],
    },
  });
  const port = createProtocolOffPeakPort(context);

  const created = await port.create({ title: "团队闲时", prompt: "执行", permissionMode: "team" });
  assert.equal(calls[0]?.params.permissionMode, "team");
  assert.equal(created.ok, true);
  assert.equal(created.ok && created.task.permissionMode, "team");

  const listed = await port.list();
  assert.deepEqual(
    listed.map((task) => task.permissionMode),
    ["team", "team", "plan"],
  );
});

test("闲时任务端口创建省略权限模式时交给 Host 默认落 Agent", async () => {
  const calls: CapturedCall[] = [];
  const context = createContext(calls, {
    [zcodeProtocolMethods.offPeakCreate]: {
      ok: true,
      task: protocolOffPeakTask("yolo"),
    },
  });
  const port = createProtocolOffPeakPort(context);
  const created = await port.create({ title: "默认", prompt: "执行" });
  assert.equal(Object.hasOwn(calls[0]?.params ?? {}, "permissionMode"), false);
  assert.equal(created.ok, true);
  assert.equal(created.ok && created.task.permissionMode, "yolo");
});
