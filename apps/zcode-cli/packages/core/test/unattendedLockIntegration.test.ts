import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  InMemorySessionEventStore,
  SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK,
  SessionEventType,
  createModelId,
  createModelProviderId,
  createSessionId,
  type Model,
  type ModelRequest,
  type ModelSelection,
  type SessionEntryInfo,
  type SessionEvent,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { InMemoryPinningSessionStore } from "./helpers/subagent-session-model-pinning-storage-fixtures.js";

// 无人值守锁的「真实入口」集成测试：admitPrompt / steerTurn / executeTurn /
// resumeFromStore 走真实 AgentRuntime，只把模型与持久化介质换成可控制、可断言的替身。
// 重点锁「时序」——同步预留、锁确认、接纳 commit、解锁写盘之间不能互相越位。

const SESSION_ID = createSessionId();
const MODEL_SELECTION: ModelSelection = {
  providerId: "demo",
  modelId: "model-a",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ModelProbe {
  requests: number;
  lockedAtRequest: boolean[];
  requestGate?: Promise<void>;
}

function createProbeModel(internal: () => AgentRuntimeInternal, probe: ModelProbe): Model {
  const build = (): Model => ({
    providerId: createModelProviderId(MODEL_SELECTION.providerId),
    modelId: createModelId(MODEL_SELECTION.modelId),
    displayName: "demo/model-a",
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 128_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["low"], map: "{}" },
      maxOutputTokens: { max: 4096, map: "{}" },
    },
    options: { reasoningLevel: "low" },
    bind() {
      return build();
    },
    async generateText(_request: ModelRequest) {
      probe.requests += 1;
      probe.lockedAtRequest.push(internal().unattendedExecutionLocked);
      if (probe.requestGate) await probe.requestGate;
      return {
        text: "done",
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        toolCalls: [],
      };
    },
    streamText(): AsyncIterable<never> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<never> {
          return {
            next: async () => {
              throw new Error("streamText is unused when modelStreaming is off");
            },
          };
        },
      };
    },
  });
  return build();
}

class GatedEventStore extends InMemorySessionEventStore {
  failOnType?: string;

  override async append(event: SessionEvent): Promise<SessionEvent> {
    if (this.failOnType === event.type) {
      throw new Error(`Injected event append failure: ${event.type}`);
    }
    return await super.append(event);
  }
}

class GatedSessionStore extends InMemoryPinningSessionStore {
  createSessionStarted = deferred();
  createSessionGate?: Promise<void>;
  /** 返回 true 时该 entry 写入失败；用于区分 true / false 两种锁写盘。 */
  failLockWrite?: (locked: boolean) => boolean;

  override async createSession(input: Parameters<InMemoryPinningSessionStore["createSession"]>[0]) {
    this.createSessionStarted.resolve();
    if (this.createSessionGate) await this.createSessionGate;
    return await super.createSession(input);
  }

  override async saveSessionEntry(entry: SessionEntryInfo): Promise<void> {
    if (
      entry.type === SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK &&
      this.failLockWrite?.(entry.data.locked === true)
    ) {
      throw new Error(`Injected lock write failure: locked=${String(entry.data.locked)}`);
    }
    return await super.saveSessionEntry(entry);
  }

  lockEntries(): SessionEntryInfo[] {
    return this.entriesFor(SESSION_ID, SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK);
  }

  lockValues(): boolean[] {
    return this.lockEntries().map((entry) => entry.data.locked === true);
  }
}

interface Harness {
  runtime: AgentRuntime;
  internal: AgentRuntimeInternal;
  store: GatedSessionStore;
  eventStore: GatedEventStore;
  probe: ModelProbe;
  workspace: string;
}

async function createHarness(t: TestContext): Promise<Harness> {
  const workspace = await mkdtemp(path.join(tmpdir(), "zcode-unattended-lock-"));
  const store = new GatedSessionStore();
  const eventStore = new GatedEventStore();
  const probe: ModelProbe = { requests: 0, lockedAtRequest: [] };
  let internal: AgentRuntimeInternal | undefined;
  const runtime = new AgentRuntime(
    SESSION_ID,
    {
      mode: "yolo",
      modelStreaming: "off",
      modelSelection: MODEL_SELECTION,
      workingDirectory: workspace,
      workspacePath: workspace,
      language: "zh-CN",
    },
    {
      eventStore,
      sessionStore: store.port,
      modelFactory: () => createProbeModel(() => internal!, probe),
    },
  );
  internal = runtime as unknown as AgentRuntimeInternal;
  t.after(async () => {
    runtime.beginShutdown();
    await rm(workspace, { recursive: true, force: true });
  });
  return { runtime, internal, store, eventStore, probe, workspace };
}

async function startAutomationTurn(
  harness: Harness,
  text = "automation work",
): Promise<{ completion: Promise<unknown> }> {
  const receipt = await harness.runtime.admitPrompt(text, undefined, {
    automationId: "automation-1",
    delivery: "auto",
  });
  assert.equal(receipt.kind, "started");
  return { completion: receipt.completion as Promise<unknown> };
}

test("自动化 turn 在首个模型请求前已完成加锁", async (t) => {
  const harness = await createHarness(t);
  const { completion } = await startAutomationTurn(harness);
  await completion;

  assert.deepEqual(harness.probe.lockedAtRequest, [true]);
  assert.deepEqual(harness.store.lockValues(), [true]);
  assert.equal(harness.internal.unattendedExecutionLocked, true);
});

test("初始化窗口内被接受的人工排队输入不会被本 turn 重新锁回", async (t) => {
  const harness = await createHarness(t);
  const gate = deferred();
  harness.store.createSessionGate = gate.promise;

  const { completion } = await startAutomationTurn(harness);
  await harness.store.createSessionStarted.promise;

  // admission 返回前 turn 已进入 createSession await；此时 activeTurn 尚未暴露，
  // 人工输入按 busy 走 deferred queue，必须真正被接纳。
  const human = await harness.runtime.admitPrompt("human follow-up", undefined, {
    delivery: "queue",
    unlocksUnattendedModeSwitch: true,
  });
  assert.equal(human.kind, "queued");

  gate.resolve();
  await completion;

  // 人工消息接纳 commit 先于本 turn 的锁确认，锁不得回写。
  assert.deepEqual(harness.probe.lockedAtRequest, [false]);
  assert.deepEqual(harness.store.lockValues(), []);
  assert.equal(harness.internal.unattendedExecutionLocked, false);
});

test("appendEvent 失败时 steer 未接纳，锁保持", async (t) => {
  const harness = await createHarness(t);
  const gate = deferred();
  harness.probe.requestGate = gate.promise;

  const { completion } = await startAutomationTurn(harness);
  while (harness.probe.requests === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.internal.unattendedExecutionLocked, true);

  harness.eventStore.failOnType = SessionEventType.TurnSteerQueued;
  await assert.rejects(
    harness.runtime.steerTurn({
      input: "human steer",
      unlocksUnattendedModeSwitch: true,
    }),
    /Injected event append failure/,
  );

  assert.equal(harness.internal.unattendedExecutionLocked, true);
  assert.deepEqual(harness.store.lockValues(), [true]);

  gate.resolve();
  await completion;
});

test("非 busy admission 的 reservation 失败时不解锁", async (t) => {
  const harness = await createHarness(t);
  await startAutomationTurn(harness).then(({ completion }) => completion);
  assert.equal(harness.internal.unattendedExecutionLocked, true);

  const internal = harness.internal as unknown as {
    reserveTurnStart: AgentRuntimeInternal["reserveTurnStart"];
  };
  const original = internal.reserveTurnStart;
  internal.reserveTurnStart = () => {
    throw new Error("Injected reservation conflict");
  };
  try {
    await assert.rejects(
      harness.runtime.admitPrompt("new human input", undefined, {
        unlocksUnattendedModeSwitch: true,
      }),
      /Injected reservation conflict/,
    );
  } finally {
    internal.reserveTurnStart = original;
  }

  assert.equal(harness.internal.unattendedExecutionLocked, true);
  assert.deepEqual(harness.store.lockValues(), [true]);
});

test("busy steer 解锁写盘失败：输入仍 accepted，锁保持且只入队一次", async (t) => {
  const harness = await createHarness(t);
  const gate = deferred();
  harness.probe.requestGate = gate.promise;

  const { completion } = await startAutomationTurn(harness);
  while (harness.probe.requests === 0) await new Promise((resolve) => setImmediate(resolve));

  harness.store.failLockWrite = (locked) => locked === false;
  const receipt = await harness.runtime.steerTurn({
    input: "human steer",
    unlocksUnattendedModeSwitch: true,
  });

  // 事件已接纳：不能把输入报成失败，否则调用方重发会产生重复消息。
  assert.equal(receipt.kind, "queued");
  assert.equal(receipt.queueLength, 1);
  const queued = (await harness.eventStore.getEvents(SESSION_ID)).filter(
    (event) => event.type === SessionEventType.TurnSteerQueued,
  );
  assert.equal(queued.length, 1);
  assert.equal(harness.internal.unattendedExecutionLocked, true);
  assert.deepEqual(harness.store.lockValues(), [true]);

  // 下一条真正的新消息会再次尝试解锁并成功。
  harness.store.failLockWrite = undefined;
  const next = await harness.runtime.steerTurn({
    input: "human steer 2",
    unlocksUnattendedModeSwitch: true,
  });
  assert.equal(next.kind, "queued");
  assert.equal(harness.internal.unattendedExecutionLocked, false);
  // 锁 entry 以稳定 id 覆盖写：失败那次没落盘，成功后只剩 false。
  assert.deepEqual(harness.store.lockValues(), [false]);

  gate.resolve();
  await completion;
});

test("busy queue 解锁写盘失败：仍返回 queued，pending 只有一条", async (t) => {
  const harness = await createHarness(t);
  const gate = deferred();
  harness.probe.requestGate = gate.promise;

  const { completion } = await startAutomationTurn(harness);
  while (harness.probe.requests === 0) await new Promise((resolve) => setImmediate(resolve));

  harness.store.failLockWrite = (locked) => locked === false;
  const receipt = await harness.runtime.admitPrompt("human queued", undefined, {
    delivery: "queue",
    unlocksUnattendedModeSwitch: true,
  });

  assert.equal(receipt.kind, "queued");
  const queued = (await harness.eventStore.getEvents(SESSION_ID)).filter(
    (event) => event.type === SessionEventType.TurnSteerQueued,
  );
  assert.equal(queued.length, 1);
  assert.equal(harness.internal.unattendedExecutionLocked, true);
  assert.deepEqual(harness.store.lockValues(), [true]);

  gate.resolve();
  await completion;
});

test("idle admission 已预取消时不解锁", async (t) => {
  const harness = await createHarness(t);
  await startAutomationTurn(harness).then(({ completion }) => completion);
  assert.equal(harness.internal.unattendedExecutionLocked, true);

  const controller = new AbortController();
  controller.abort(new Error("user cancelled before dispatch"));
  const epochBefore = harness.internal.unattendedHumanInputEpoch;
  const receipt = await harness.runtime.admitPrompt("cancelled human input", undefined, {
    abortSignal: controller.signal,
    unlocksUnattendedModeSwitch: true,
  });
  assert.equal(receipt.kind, "started");
  await assert.rejects(receipt.completion, /cancel/i);

  assert.equal(harness.internal.unattendedExecutionLocked, true);
  assert.deepEqual(harness.store.lockValues(), [true]);
  assert.equal(harness.internal.unattendedHumanInputEpoch, epochBefore);
});

test("idle admission 解锁写盘失败：释放预留并让输入失败，计数不推进", async (t) => {
  const harness = await createHarness(t);
  await startAutomationTurn(harness).then(({ completion }) => completion);
  assert.equal(harness.internal.unattendedExecutionLocked, true);
  const epochBefore = harness.internal.unattendedHumanInputEpoch;

  harness.store.failLockWrite = (locked) => locked === false;
  await assert.rejects(
    harness.runtime.admitPrompt("new human input", undefined, {
      unlocksUnattendedModeSwitch: true,
    }),
    /Failed to persist the unattended execution lock/,
  );

  assert.equal(harness.internal.unattendedExecutionLocked, true);
  assert.deepEqual(harness.store.lockValues(), [true]);
  assert.equal(harness.internal.unattendedHumanInputEpoch, epochBefore);

  // 预留已释放：写盘恢复后可再次接纳。
  harness.store.failLockWrite = undefined;
  const retry = await harness.runtime.admitPrompt("new human input", undefined, {
    unlocksUnattendedModeSwitch: true,
  });
  assert.equal(retry.kind, "started");
  await retry.completion;
  assert.equal(harness.internal.unattendedExecutionLocked, false);
});

test("冷恢复通过真实 resumeFromStore 还原锁，不自动解锁", async (t) => {
  const harness = await createHarness(t);
  await startAutomationTurn(harness).then(({ completion }) => completion);
  assert.equal(harness.internal.unattendedExecutionLocked, true);

  const resumed = new AgentRuntime(
    SESSION_ID,
    {
      mode: "yolo",
      modelStreaming: "off",
      modelSelection: MODEL_SELECTION,
      workingDirectory: harness.workspace,
      workspacePath: harness.workspace,
      language: "zh-CN",
    },
    {
      eventStore: harness.eventStore,
      sessionStore: harness.store.port,
      modelFactory: () =>
        createProbeModel(() => resumed as unknown as AgentRuntimeInternal, {
          requests: 0,
          lockedAtRequest: [],
        }),
    },
  );
  t.after(() => resumed.beginShutdown());
  await resumed.resumeFromStore();

  assert.equal((resumed as unknown as AgentRuntimeInternal).unattendedExecutionLocked, true);
  assert.deepEqual(harness.store.lockValues(), [true]);
});

test("队列提升与内部续跑不携带人工标记时保持锁", async (t) => {
  const harness = await createHarness(t);
  await startAutomationTurn(harness).then(({ completion }) => completion);
  assert.equal(harness.internal.unattendedExecutionLocked, true);

  const promoted = await harness.runtime.admitPrompt("promoted queue item", undefined, {
    requireIdle: true,
  });
  assert.equal(promoted.kind, "started");
  await promoted.completion;

  await harness.internal.executeTurn("internal retry", undefined, {
    inputSource: "goal-continuation",
    inputVisibility: "model-only",
  });

  assert.equal(harness.internal.unattendedExecutionLocked, true);
  assert.deepEqual(harness.store.lockValues(), [true]);
});
