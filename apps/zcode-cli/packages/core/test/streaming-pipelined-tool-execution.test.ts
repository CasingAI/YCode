import assert from "node:assert/strict";
import test from "node:test";
import type { ModelToolCall, SessionEvent, ToolCallId, ToolExecutionResult } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";
import {
  collectCommittedResults,
  createStreamingToolCoordinator,
} from "../src/runtime/methods/streaming-tool-coordinator.js";
import { scheduleTools } from "../src/runtime/methods/tools.js";
import { ToolScheduler } from "../src/tool/scheduler.js";

// 流式增量执行的行为契约（docs/specs/streaming-pipelined-tool-execution.md）：
// 1) tool call 参数一闭合就进入调度起跑，不再等流结束；
// 2) 起跑顺序仍由 ToolScheduler 的分组决定：副作用工具之间严格串行，声明在副作用工具
//    之后的只读工具要等它结束，但不要求流结束；
// 3) turn stop 之后才起跑的工具按同一条取消边界产出 ToolCancelled，已起跑的照常收尾；
// 4) 断流恢复等真实结果，既不合成 unknown_execution_state，也不让流后路径重放。

type ToolMetadata = Record<string, unknown>;

const READ_ONLY: ToolMetadata = {
  readOnly: true,
  concurrentSafe: true,
  sideEffectScope: "none",
};

const SIDE_EFFECT: ToolMetadata = {
  readOnly: false,
  concurrentSafe: false,
  sideEffectScope: "workspace",
};

const ASK: ToolMetadata = {
  readOnly: true,
  concurrentSafe: true,
  needsApproval: true,
  requiresUserInteraction: true,
  sideEffectScope: "userInteraction",
};

interface CoordinatorHandle {
  accept: (toolCallId: string, name: string) => void;
  drain: () => Promise<
    Array<{ toolCallId: string; success: boolean; errorType?: string; modelContent?: string }>
  >;
  executions: string[];
  release: (toolCallId: string, patch?: Partial<ToolExecutionResult>) => void;
  started: string[];
  waitFor: (predicate: () => boolean) => Promise<void>;
}

interface Harness {
  coordinator: CoordinatorHandle;
  toolCalls: ModelToolCall[];
}

function createHarness(
  toolMetadata: Record<string, ToolMetadata>,
  config: Record<string, unknown> = { modelStreaming: "on" },
): Harness {
  const started: string[] = [];
  const executions: string[] = [];
  const errors: string[] = [];
  const pending = new Map<string, (result: ToolExecutionResult) => void>();
  const toolCalls: ModelToolCall[] = [];

  const registry = {
    get: (name: string) => {
      const metadata = toolMetadata[name];
      if (!metadata) return undefined;
      return {
        metadata: { name, ...metadata },
        permission: { sideEffectScope: metadata.sideEffectScope },
      };
    },
    getMetadata: (name: string) => {
      const metadata = toolMetadata[name];
      return metadata ? ({ name, ...metadata } as never) : undefined;
    },
    has: (name: string) => Object.hasOwn(toolMetadata, name),
  };

  const runtime = {
    sessionId: "session-pipeline" as never,
    config,
    registry,
    // 扫描失败必须能被测试看见，否则「什么都没起跑」会被误读成断言问题。
    logger: {
      debug: () => {},
      error: (error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
      info: () => {},
      warn: (context: unknown) => {
        errors.push(`warn:${JSON.stringify(context)}`);
      },
    },
    toolScheduler: new ToolScheduler(),
    // 分组语义走真实实现：coordinator 不允许自己另写一套并行判定。
    scheduleTools: (calls: ModelToolCall[]) => scheduleTools.call(runtime, calls),
    emitToolScheduledEvents: async () => [],
    executeTools: async (
      calls: ModelToolCall[],
      _schedule: unknown,
      options?: { onBatchStart?: (ids: string[]) => Promise<void> },
    ) => {
      const ids = calls.map((call) => call.id);
      await options?.onBatchStart?.(ids);
      started.push(...ids);
      const results = await Promise.all(
        calls.map(
          (call) =>
            new Promise<ToolExecutionResult>((resolve) => {
              executions.push(call.id);
              pending.set(call.id, resolve);
            }),
        ),
      );
      return { results, events: [] as SessionEvent[] };
    },
    persistPart: async () => {},
    createEvent: (type: string, payload: unknown) => ({ type, payload }) as never,
    appendEvent: async () => {},
  } as unknown as AgentRuntimeInternal;

  const state = {
    turnAbortSignal: new AbortController().signal,
    events: [],
    model: { providerId: "provider-1", modelId: "model-1" },
    toolDisallowlist: [],
    turnId: "turn-1" as never,
    turnTraceContext: { queryId: "", traceId: "trace-1" as never },
  } as unknown as RegularTurnLoopState;

  const coordinator = createStreamingToolCoordinator(runtime, state, {
    assistantMessageId: "assistant-1" as never,
    model: state.model,
    traceContext: { traceId: "trace-1" as never },
  });

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.fail(`等待超时：started=[${started.join(",")}] errors=[${errors.join(" | ")}]`);
  };

  return {
    toolCalls,
    coordinator: {
      accept: (toolCallId, name) => {
        const toolCall = { id: toolCallId, input: {}, name } as ModelToolCall;
        toolCalls.push(toolCall);
        coordinator.accept(toolCall);
      },
      drain: async () => {
        const results = await coordinator.drain(toolCalls);
        return results.map((entry) => ({
          toolCallId: entry.toolCallId,
          success: entry.result.success,
          errorType: entry.result.error?.type,
          modelContent:
            typeof entry.result.modelContent === "string"
              ? entry.result.modelContent
              : undefined,
        }));
      },
      executions,
      release: (toolCallId, patch) => {
        const resolve = pending.get(toolCallId);
        if (!resolve) assert.fail(`工具 ${toolCallId} 没有在执行中`);
        const now = new Date();
        resolve({
          completedAt: now,
          durationMs: 1,
          modelContent: "ok",
          output: {},
          startedAt: now,
          success: true,
          toolCallId: toolCallId as ToolCallId,
          toolName: "Test",
          ...patch,
        } as ToolExecutionResult);
      },
      started,
      waitFor,
    },
  };
}

test("副作用工具按声明顺序排队，提问在它结束时立刻起跑", async () => {
  const { coordinator } = createHarness({
    AskUserQuestion: ASK,
    Bash: SIDE_EFFECT,
    Grep: READ_ONLY,
    Read: READ_ONLY,
  });

  coordinator.accept("call-read", "Read");
  await coordinator.waitFor(() => coordinator.started.includes("call-read"));
  assert.deepEqual(coordinator.started, ["call-read"]);

  // 声明顺序 Read / Bash / Grep / Ask 的分组是 [Read] [Bash] [Grep, Ask]：
  // Bash 声明在 Grep 之前，Grep 就必须等它，不能只看「都是只读工具」。
  coordinator.accept("call-bash", "Bash");
  coordinator.accept("call-grep", "Grep");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(coordinator.started, ["call-read"]);

  coordinator.release("call-read");
  await coordinator.waitFor(() => coordinator.started.includes("call-bash"));
  assert.deepEqual(coordinator.started, ["call-read", "call-bash"]);

  // 提问与 Grep 同组：Bash 一结束就一起起跑，不等流结束。
  coordinator.accept("call-ask", "AskUserQuestion");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!coordinator.started.includes("call-ask"));

  coordinator.release("call-bash");
  await coordinator.waitFor(() => coordinator.started.includes("call-ask"));
  assert.deepEqual(coordinator.started, [
    "call-read",
    "call-bash",
    "call-grep",
    "call-ask",
  ]);
});

test("同一并行组内的只读工具一起起跑", async () => {
  const { coordinator } = createHarness({ Grep: READ_ONLY, Read: READ_ONLY });

  coordinator.accept("call-read", "Read");
  coordinator.accept("call-grep", "Grep");
  await coordinator.waitFor(() => coordinator.started.length === 2);
  assert.deepEqual(coordinator.started, ["call-read", "call-grep"]);
});

test("未注册工具不参与流中调度，也不堵住后面的工具", async () => {
  const { coordinator } = createHarness({ Read: READ_ONLY });

  coordinator.accept("call-ghost", "NotRegisteredTool");
  coordinator.accept("call-read", "Read");
  await coordinator.waitFor(() => coordinator.started.includes("call-read"));
  assert.deepEqual(coordinator.started, ["call-read"]);

  coordinator.release("call-read");
  const drained = await coordinator.drain();
  // 未注册工具没有流式结果，交给流后路径拿 registry-miss 的成对结果。
  assert.deepEqual(
    drained.map((entry) => entry.toolCallId),
    ["call-read"],
  );
});

test("两个副作用工具之间仍然严格串行", async () => {
  const { coordinator } = createHarness({ Bash: SIDE_EFFECT, Edit: SIDE_EFFECT });

  coordinator.accept("call-bash", "Bash");
  await coordinator.waitFor(() => coordinator.started.includes("call-bash"));
  coordinator.accept("call-edit", "Edit");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(coordinator.started, ["call-bash"]);

  coordinator.release("call-bash");
  await coordinator.waitFor(() => coordinator.started.includes("call-edit"));
  assert.deepEqual(coordinator.started, ["call-bash", "call-edit"]);
});

test("drain 按声明顺序收齐结果，工具各执行一次", async () => {
  const { coordinator } = createHarness({ Bash: SIDE_EFFECT, Read: READ_ONLY });

  coordinator.accept("call-bash", "Bash");
  await coordinator.waitFor(() => coordinator.started.includes("call-bash"));
  coordinator.accept("call-read", "Read");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(coordinator.started, ["call-bash"]);

  coordinator.release("call-bash");
  await coordinator.waitFor(() => coordinator.started.includes("call-read"));
  coordinator.release("call-read");

  const drained = await coordinator.drain();
  assert.deepEqual(
    drained.map((entry) => entry.toolCallId),
    ["call-bash", "call-read"],
  );
  assert.ok(drained.every((entry) => entry.success));
  assert.deepEqual(coordinator.executions, ["call-bash", "call-read"]);
});

test("drain 不漏掉刚被解锁的工具：前一个工具结束后立刻 drain 仍能收齐两个结果", async () => {
  const { coordinator } = createHarness({ Bash: SIDE_EFFECT, Read: READ_ONLY });

  coordinator.accept("call-bash", "Bash");
  await coordinator.waitFor(() => coordinator.started.includes("call-bash"));
  coordinator.accept("call-read", "Read");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(coordinator.started, ["call-bash"]);

  // 关键：不等 Read 起跑就直接 drain。Read 在 Bash 结束的那一瞬才被解锁，
  // drain 必须先让扫描链跑完再收结果，否则会漏掉它并让流后路径重复执行。
  coordinator.release("call-bash");
  const drainedPromise = coordinator.drain();
  await new Promise((resolve) => setTimeout(resolve, 10));
  coordinator.release("call-read");
  const drained = await drainedPromise;

  assert.deepEqual(
    drained.map((entry) => entry.toolCallId),
    ["call-bash", "call-read"],
  );
  assert.deepEqual(coordinator.executions, ["call-bash", "call-read"]);
});

test("turn stop 之后未起跑的工具拿到 ToolCancelled，已起跑的照常收尾", async () => {
  const { coordinator } = createHarness({ Bash: SIDE_EFFECT, Edit: SIDE_EFFECT, Read: READ_ONLY });

  coordinator.accept("call-bash", "Bash");
  await coordinator.waitFor(() => coordinator.started.includes("call-bash"));
  coordinator.accept("call-edit", "Edit");
  coordinator.accept("call-read", "Read");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(coordinator.started, ["call-bash"]);

  coordinator.release("call-bash", {
    turnControl: { reason: "plan_exit_denied", stopTurnAfterResult: true },
  } as Partial<ToolExecutionResult>);

  const drained = await coordinator.drain();
  assert.deepEqual(
    drained.map((entry) => entry.toolCallId),
    ["call-bash", "call-edit", "call-read"],
  );
  assert.equal(drained[0]?.success, true);
  assert.equal(drained[1]?.errorType, "tool_cancelled");
  assert.equal(drained[2]?.errorType, "tool_cancelled");
  assert.match(drained[1]?.modelContent ?? "", /previous tool result requested a turn stop/);
  // Edit / Read 从未起跑，不得被真正执行。
  assert.deepEqual(coordinator.executions, ["call-bash"]);
});

test("streamingToolExecution=off 时全部等流结束，与改动前一致", async () => {
  const { coordinator } = createHarness(
    { Bash: SIDE_EFFECT, Read: READ_ONLY },
    { modelStreaming: "on", streamingToolExecution: "off" },
  );

  coordinator.accept("call-read", "Read");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(coordinator.started, []);
  assert.deepEqual(coordinator.executions, []);

  // 流结束后由 pending 路径执行，coordinator 不产出流式结果。
  const drained = await coordinator.drain();
  assert.deepEqual(drained, []);
});

test("断流恢复等在途工具的真实结果，不合成也不重放", async () => {
  const startedAt = new Date(1_700_000_000_000);
  const realResult: ToolExecutionResult = {
    completedAt: new Date(startedAt.getTime() + 5),
    durationMs: 5,
    modelContent: "ok",
    output: {},
    startedAt,
    success: true,
    toolCallId: "call-bash" as ToolCallId,
    toolName: "Bash",
  };
  const handles = new Map<
    string,
    Promise<{ result: ToolExecutionResult; toolCallId: string } | undefined>
  >([
    [
      "call-bash",
      Promise.resolve({ result: realResult, toolCallId: "call-bash" as unknown as ToolCallId }),
    ],
  ]);
  const toolCalls = [
    { id: "call-bash", input: {}, name: "Bash" },
    { id: "call-read", input: {}, name: "Read" },
  ] as ModelToolCall[];

  const committed = await collectCommittedResults(handles as never, toolCalls);

  // 在途工具用真实结果；从未起跑的工具不进流式结果，交给流后路径执行一次。
  assert.deepEqual(
    committed.map((entry) => entry.toolCallId),
    ["call-bash"],
  );
  assert.equal(committed[0]?.result.modelContent, "ok");
  assert.equal(committed[0]?.result.success, true);
});
