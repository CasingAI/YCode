// appendEvent 的投递可达性不变量。
//
// eventStore.append 一旦分配 sequenceNumber，该序号就已被消费端看不见地消耗。
// 消费端（bootstrap v4-gateway 的 normalizeRuntimeEventSequence）只按 raw seq 连续
// drain，所以「序号被消耗但事件永不进 live sink」= 投影永久冻结在缺口之前，
// 列表上表现为「运行中 + 等待确认」而实际什么都没在跑。
//
// 因此 appendEvent 内部除 eventStore.append 之外的每一步都必须是 best-effort：
// 失败降级为 warn，绝不能阻断 notifyEventSinks。这条测试从 appendEvent 的真实入口
// 验证这条契约：无论持久化与用量记账怎么失败，sink 必须收到事件。
//
// 其中后两条在「appendEvent 用一个大 try 包住全部四步」的实现下会失败（rethrow 跳过
// notifyEventSinks），是这条不变量的回归护栏；checkpoint 那条因为分支自身已有 try，
// 在两种实现下都通过，它锁的是两条持久化分支的错误边界同构。
import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent } from "../src/runtime/methods/events.js";

const TRACE = { traceId: "trace-append", turnId: "turn-append" } as never;

function sessionEvent(type: string) {
  return {
    id: `event-append-${type}`,
    sessionId: "session-append",
    turnId: "turn-append",
    type,
    timestamp: new Date(1_700_000_000_000),
    traceId: "trace-append",
    sequenceNumber: 0,
    payload: {},
  };
}

interface Harness {
  runtime: Record<string, unknown>;
  delivered: string[];
  warnings: string[];
}

function createHarness(options: {
  saveSessionEntry?: () => Promise<void>;
  usageStoreThrows?: boolean;
} = {}): Harness {
  const delivered: string[] = [];
  const warnings: string[] = [];
  let issued = 0;
  const runtime: Record<string, unknown> = {
    sessionId: "session-append",
    logger: {
      info: () => {},
      debug: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
    },
    eventStore: {
      append: async (event: Record<string, unknown>) => {
        issued += 1;
        return { ...event, sequenceNumber: issued };
      },
    },
    eventSinks: new Set([
      {
        onSessionEvent: async (event: { id: string }) => {
          delivered.push(String(event.id));
        },
      },
    ]),
    notifyEventSinks: async function (this: Record<string, unknown>, event: { id: string }) {
      for (const sink of this.eventSinks as Set<{ onSessionEvent(e: { id: string }): Promise<void> }>) {
        await sink.onSessionEvent(event);
      }
    },
    sessionStore: {
      saveSessionEntry: options.saveSessionEntry ?? (async () => {}),
      recordModelUsage: async () => {},
      upsertTurnUsage: async () => {},
      // 记账失败是真实故障面：usage store 落盘错误不得让事件停止投递。
      upsertToolUsage: options.usageStoreThrows
        ? async () => {
            throw new Error("usage store unavailable");
          }
        : async () => {},
      pruneUsage: async () => {},
    },
  };
  return { runtime, delivered, warnings };
}

// appendEvent 的第一个声明参数是 this（TS 侧），运行时签名是 (event, traceContext)。
// 这里必须 bind 而不是直接调用：直接调用时 this 是 undefined，
// 参数会整体左移一位（实测 this.eventStore 读的是 undefined）。
const appendBound = (runtime: unknown) =>
  (appendEvent as unknown as (event: unknown, trace: unknown) => Promise<void>).bind(runtime);

test("持久化抛错时，事件仍必须抵达 live sink", async () => {
  const { runtime, delivered } = createHarness({
    saveSessionEntry: async () => {
      throw new Error("session store unavailable");
    },
  });
  // CheckpointCreated 走 persistWorkspaceCheckpointEntry，会真的调 saveSessionEntry。
  await appendBound(runtime)(sessionEvent("checkpoint_created"), TRACE);
  assert.deepEqual(delivered, ["event-append-checkpoint_created"]);
});

test("用量记账抛错时，事件仍必须抵达 live sink", async () => {
  const { runtime, delivered } = createHarness({ usageStoreThrows: true });
  await appendBound(runtime)(
    { ...sessionEvent("tool_call_started"), payload: { toolCallId: "call-1", toolName: "bash" } },
    TRACE,
  );
  assert.deepEqual(delivered, ["event-append-tool_call_started"]);
});

test("持久化与用量同时失败也必须投递，且只记 warn 不抛", async () => {
  const { runtime, delivered, warnings } = createHarness({
    saveSessionEntry: async () => {
      throw new Error("session store unavailable");
    },
    usageStoreThrows: true,
  });
  await appendBound(runtime)(
    { ...sessionEvent("tool_call_started"), payload: { toolCallId: "call-1", toolName: "bash" } },
    TRACE,
  );
  assert.deepEqual(delivered, ["event-append-tool_call_started"]);
  assert.ok(warnings.length > 0, "失败必须留 warn 现场，不得静默");
});
