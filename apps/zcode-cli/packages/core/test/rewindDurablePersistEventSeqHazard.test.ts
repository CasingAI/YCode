// 事件序号被消耗却永不投递的回归测试。
//
// core 的 appendEvent（runtime/methods/events.ts）在同一个 try 里依次做
// append → persistDurable → recordUsage → notifyEventSinks，catch 只 log 后 rethrow。
// eventStore.append 是纯内存且不抛错，notifyEventSinks 逐 sink 吞错且永不 reject，
// 所以「序号被消耗但事件不投递」只可能来自第 2 步 persistDurableSessionEvent 里
// 任何一个没有 try 保护的 await。
//
// workspace-checkpoint-persistence.ts 里两条分支的错误边界曾经不对称：
//   - persistWorkspaceCheckpointEntry：parseCheckpointCreatedPayload 在 try 内（只 warn）。
//   - persistWorkspaceFileRewindEntry：parseRewindTriggeredPayload 在 try 外（会抛）。
// 事件一旦在中途抛出，appendEvent 的 rethrow 就会跳过 notifyEventSinks。
// 这条测试把两条分支钉在同一形状上：非法 payload 一律降级为 warn，合法 payload 一律落盘。
import assert from "node:assert/strict";
import test from "node:test";
import { RewindScope, RewindStrategy } from "@zcode/contracts";
import {
  persistWorkspaceCheckpointEntry,
  persistWorkspaceFileRewindEntry,
} from "../src/runtime/methods/workspace-checkpoint-persistence.js";

const TRACE = { traceId: "trace-rewind" };

function runtimeWithStore(): {
  runtime: Record<string, unknown>;
  saved: unknown[];
  warnings: unknown[];
} {
  const saved: unknown[] = [];
  const warnings: unknown[] = [];
  const runtime: Record<string, unknown> = {
    sessionStore: {
      saveSessionEntry: async (entry: unknown) => {
        saved.push(entry);
      },
    },
    logger: {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    },
  };
  return { runtime, saved, warnings };
}

function sessionEvent(type: string, payload: unknown) {
  return {
    id: "event-rewind-1",
    sessionId: "session-rewind",
    turnId: "turn-rewind",
    type,
    timestamp: new Date(1_700_000_000_000),
    traceId: "trace-rewind",
    sequenceNumber: 7,
    payload,
  };
}

// 直接调用，与 events.ts 的生产调用形式一致。
// 这里不能用 Function.prototype.call/apply：tsx 加载的 ESM 绑定上，thisArg 会被
// 当成第一个实参传入（实测 arguments.length 少 1），断言会得到假绿。
const persistFileRewind = persistWorkspaceFileRewindEntry as unknown as (
  runtime: unknown,
  event: unknown,
  trace: unknown,
) => Promise<void>;
const persistCheckpoint = persistWorkspaceCheckpointEntry as unknown as (
  runtime: unknown,
  event: unknown,
  trace: unknown,
) => Promise<void>;

test("checkpoint 分支：payload 非法时只 warn，不把异常抛给 appendEvent", async () => {
  const { runtime, warnings } = runtimeWithStore();
  await persistCheckpoint(runtime, sessionEvent("checkpoint_created", {}), TRACE);
  assert.ok(warnings.length > 0, "非法 checkpoint payload 应被降级为 warn");
});

test("rewind 分支：payload 非法时必须被降级为 warn，不得抛回 appendEvent", async () => {
  const { runtime, warnings } = runtimeWithStore();
  // schema 是 .strict()，缺 rewindId / scope / strategy 必然抛。
  await persistFileRewind(runtime, sessionEvent("rewind_triggered", {}), TRACE);
  assert.ok(
    warnings.length > 0,
    "非法 rewind payload 必须与 checkpoint 分支同构：记 warn 后继续，不得让 notifyEventSinks 被跳过",
  );
});

test("rewind 分支：多一个字段也要降级（.strict() 拒收额外键）", async () => {
  const { runtime, warnings, saved } = runtimeWithStore();
  await persistFileRewind(
    runtime,
    sessionEvent("rewind_triggered", {
      rewindId: "rewind-1",
      scope: RewindScope.Workspace,
      strategy: RewindStrategy.FileOnly,
      reason: "file_summary_rewind",
      // 生产上任何多带一个字段都会让 strict parse 抛；这正是必须被 try 兜住的形状。
      unexpectedField: true,
    }),
    TRACE,
  );
  assert.ok(warnings.length > 0, "strict parse 拒绝的 payload 不得抛出");
  assert.equal(saved.length, 0, "解析失败时不得写入半成品条目");
});

test("rewind 分支：合法 workspace + file_summary_rewind payload 仍然落盘", async () => {
  const { runtime, saved, warnings } = runtimeWithStore();
  await persistFileRewind(
    runtime,
    sessionEvent("rewind_triggered", {
      rewindId: "rewind-1",
      scope: RewindScope.Workspace,
      strategy: RewindStrategy.FileOnly,
      reason: "file_summary_rewind",
    }),
    TRACE,
  );
  assert.equal(saved.length, 1, "合法 payload 的持久化行为不得被降级逻辑吞掉");
  assert.equal(warnings.length, 0, "合法 payload 不该产生 warn");
});
