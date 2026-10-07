// v4/command 对冷会话的按需恢复（docs/specs/v4-command-cold-session-resume.md）。
//
// 回归目标：「重新生成标题」对隔夜/重启后冷任务稳定失败——命令在网关入口
// 即被 proto.sessionNotFound 拒绝（host 日志：2.6ms FAIL），标题 sidecar
// 全程零调用。用例锁定三条语义：
// 1. 冷会话（store 有、内存无）+ 恢复成功 → 不再 sessionNotFound，命令正常执行；
// 2. store 无此会话 → 照旧 sessionNotFound（语义不漂移）；
// 3. 恢复中途失败 → 同样 sessionNotFound（原始 cause 进 onError 日志，不提前定性）。
import assert from "node:assert/strict";
import test from "node:test";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const SESSION_ID = "session-cold-command";
const T0 = 1_700_000_000_000;

function envelope() {
  return {
    commandId: "command-cold-resume-test",
    clientId: "client-test",
    sessionId: SESSION_ID,
    type: "regenerateSessionTitle",
    payload: {},
    issuedAt: T0,
  };
}

interface TestHostState {
  resident: boolean;
  persisted: boolean;
  resumeCalls: number;
  resumeShouldThrow: boolean;
  errors: Array<{ scope: string }>;
}

function createGateway(state: TestHostState) {
  const host = {
    sessionExists: () => state.resident,
    // 宿主恢复钩子：store 有则回填注册表（置 resident=true），与生产 v4-bridge 同形。
    resumePersistedSession: async () => {
      state.resumeCalls += 1;
      if (state.resumeShouldThrow) throw new Error("resume boom");
      if (!state.persisted) return { status: "notFound" as const };
      state.resident = true;
      return { status: "resumed" as const };
    },
    emitWireFrame: () => {},
    onError: (scope: string) => {
      state.errors.push({ scope });
    },
    executeCommand: async () => undefined,
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "cold-command-epoch",
  });
  return gateway;
}

function createState(): TestHostState {
  return { resident: false, persisted: true, resumeCalls: 0, resumeShouldThrow: false, errors: [] };
}

test("冷会话命令先恢复再执行：regenerateSessionTitle 不再 sessionNotFound", async () => {
  const state = createState();
  const gateway = createGateway(state);

  const ack = await gateway.handleCommand(envelope());

  assert.equal(state.resumeCalls, 1);
  assert.equal(ack.status, "accepted");
});

test("store 无此会话：照旧 sessionNotFound，不改变客户端语义", async () => {
  const state = createState();
  state.persisted = false;
  const gateway = createGateway(state);

  const ack = await gateway.handleCommand(envelope());

  assert.equal(state.resumeCalls, 1);
  assert.equal(ack.status, "rejected");
  assert.equal(ack.reasonCode, "proto.sessionNotFound");
});

test("恢复中途失败：回落 sessionNotFound，原始 cause 进 onError 日志", async () => {
  const state = createState();
  state.resumeShouldThrow = true;
  const gateway = createGateway(state);

  const ack = await gateway.handleCommand(envelope());

  assert.equal(ack.status, "rejected");
  assert.equal(ack.reasonCode, "proto.sessionNotFound");
  assert.ok(
    state.errors.some((record) => record.scope === "v4.command.coldResume"),
    "恢复失败应进 onError 日志",
  );
});

test("热会话命令不触发恢复：无额外开销", async () => {
  const state = createState();
  state.resident = true;
  const gateway = createGateway(state);

  const ack = await gateway.handleCommand(envelope());

  assert.equal(state.resumeCalls, 0);
  assert.equal(ack.status, "accepted");
});
