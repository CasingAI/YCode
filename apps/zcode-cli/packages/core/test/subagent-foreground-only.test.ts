import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentInputJsonSchema,
  AgentRuntimeInputSchema,
  createSessionId,
  createToolCallId,
  createTraceId,
} from "@zcode/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { parseAgentProfileFromMarkdown } from "../src/subagent/profile.js";
import { createAgentToolEntry } from "../src/tool/handlers/agent.js";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";

function request(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: createSessionId(),
    parentToolCallId: createToolCallId(),
    agentType: "general-purpose",
    description: "foreground test",
    prompt: "return the result",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    trace: { traceId: createTraceId() },
    ...overrides,
  };
}

function isBackgroundUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "context" in error &&
    (error as { context?: { code?: string } }).context?.code === "agent_background_unavailable"
  );
}

test("provider Agent schema hides background input while runtime keeps legacy parsing", () => {
  assert.equal("run_in_background" in (AgentInputJsonSchema.properties ?? {}), false);
  assert.equal(
    AgentRuntimeInputSchema.parse({
      description: "x",
      prompt: "y",
      run_in_background: true,
    }).run_in_background,
    true,
  );
  assert.equal(createAgentToolEntry().metadata.description?.includes("run_in_background"), false);
  assert.match(createAgentToolEntry().metadata.description ?? "", /parent turn waits/i);
});

test("explicit background launch is rejected before a child is created", async () => {
  const port = createExploreSubagentPort({
    runExploreAgent: async () => {
      throw new Error("child must not start");
    },
    emitParentEvent: async () => {},
  });

  await assert.rejects(
    port.launch({ ...request(), runInBackground: true }),
    isBackgroundUnavailableError,
  );
});

test("Agent handler rejects a legacy background request before calling the port", async () => {
  let runCalled = false;
  const handler = createAgentToolEntry().handler;

  await assert.rejects(
    handler(
      {
        description: "legacy background",
        prompt: "return the result",
        run_in_background: true,
      },
      {
        sessionId: createSessionId(),
        toolCallId: createToolCallId(),
        subagentPort: {
          run: async () => {
            runCalled = true;
            throw new Error("must not run");
          },
        },
      } as never,
    ),
    isBackgroundUnavailableError,
  );
  assert.equal(runCalled, false);
});

test("autoBackgroundMs cannot detach a foreground child", async () => {
  let started = false;
  const port = createExploreSubagentPort({
    autoBackgroundMs: 1,
    runExploreAgent: async (child) => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { response: "foreground result", traceId: child.traceContext.traceId, events: [] };
    },
    emitParentEvent: async () => {},
  });

  const output = await port.run(request());
  assert.equal(started, true);
  assert.equal(output.status, "completed");
  assert.equal(output.content[0]?.text, "foreground result");
});

test("concurrent foreground agents join only after every child reaches a terminal result", async () => {
  let running = 0;
  let maximumRunning = 0;
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      try {
        await new Promise((resolve) => setTimeout(resolve, child.description === "fast" ? 5 : 20));
        if (child.description === "failed") {
          throw new Error("expected child failure");
        }
        return {
          response: `${child.description} result`,
          traceId: child.traceContext.traceId,
          events: [],
        };
      } finally {
        running -= 1;
      }
    },
    emitParentEvent: async () => {},
  });

  const results = await Promise.allSettled([
    port.run(request({ description: "fast", parentToolCallId: createToolCallId() })),
    port.run(request({ description: "slow", parentToolCallId: createToolCallId() })),
    port.run(request({ description: "failed", parentToolCallId: createToolCallId() })),
  ]);

  assert.equal(maximumRunning, 3);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "fulfilled");
  assert.equal(results[2]?.status, "rejected");
  assert.equal(running, 0);
});

test("parent cancellation aborts the foreground child and releases the join", async () => {
  const controller = new AbortController();
  let childAborted = false;
  let childSettled = false;
  let markChildStarted!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    markChildStarted = resolve;
  });
  let markChildAborted!: () => void;
  const childAbortedPromise = new Promise<void>((resolve) => {
    markChildAborted = resolve;
  });
  let releaseChild!: () => void;
  const childCleanup = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const port = createExploreSubagentPort({
    runExploreAgent: async (_child, runOptions) => {
      return await new Promise((_resolve, reject) => {
        const signal = runOptions?.signal;
        if (!signal) {
          reject(new Error("child signal was not propagated"));
          return;
        }
        markChildStarted();
        signal.addEventListener(
          "abort",
          () => {
            childAborted = true;
            markChildAborted();
            void childCleanup.then(() => {
              childSettled = true;
              reject(signal.reason);
            });
          },
          { once: true },
        );
      });
    },
    emitParentEvent: async () => {},
  });

  const running = port.run(request(), { signal: controller.signal });
  const rejected = assert.rejects(running);
  await childStarted;
  controller.abort(new Error("parent turn cancelled"));
  await childAbortedPromise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(childAborted, true);
  assert.equal(childSettled, false);

  releaseChild();
  await rejected;
  assert.equal(childSettled, true);
});

test("stopping a foreground child does not enter the legacy background stop path", async () => {
  const agentId = "foreground-stop-test";
  let releaseChild!: () => void;
  const childFinished = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const events: string[] = [];
  let markSubagentSpawned!: () => void;
  const subagentSpawned = new Promise<void>((resolve) => {
    markSubagentSpawned = resolve;
  });
  const port = createExploreSubagentPort({
    createAgentId: () => agentId,
    runExploreAgent: async (child) => {
      await child.onSessionReady?.();
      await childFinished;
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: [],
      };
    },
    emitParentEvent: async (event) => {
      events.push(event.type);
      if (event.type === "subagent_spawned") markSubagentSpawned();
    },
  });

  const running = port.run(request());
  await subagentSpawned;
  assert.ok(port.stopTask);
  const beforeStop = await port.getTask(agentId);
  assert.equal(beforeStop?.status, "running");
  await assert.rejects(port.stopTask(agentId), isBackgroundUnavailableError);
  assert.equal(events.includes("background_task_completed"), false);
  assert.equal(events.includes("subagent_stopped"), false);

  releaseChild();
  await running;
  assert.equal(events.filter((type) => type === "background_task_completed").length, 0);
  assert.equal(events.filter((type) => type === "subagent_stopped").length, 1);
});

test("SendMessage cannot resume a completed foreground agent in the background", async () => {
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => ({
      response: "done",
      traceId: child.traceContext.traceId,
      events: [],
    }),
    emitParentEvent: async () => {},
  });

  const completed = await port.run(request());
  const result = await port.sendMessage({
    to: completed.status === "completed" ? completed.agentId : "",
    message: "continue",
    parentToolCallId: createToolCallId(),
    trace: { traceId: createTraceId() },
  });

  assert.equal(result.status, "failed");
  assert.match(result.message, /cannot resume after completion/i);
});

test("background tracking ignores legacy Agent launches but still accepts Bash launches", async () => {
  const eventTypes: string[] = [];
  const tracker = new BackgroundTaskTracker({
    sessionId: createSessionId(),
    emitEvent: async (event) => {
      eventTypes.push(event.type);
    },
  } as never);
  const traceContext = { traceId: createTraceId() };

  await tracker.trackBackgroundTask(
    { id: "agent-call", name: "Agent", input: {} } as never,
    { status: "async_launched", agentId: "agent_legacy" },
    traceContext,
    undefined,
  );
  assert.deepEqual(eventTypes, []);

  await tracker.trackBackgroundTask(
    { id: "bash-call", name: "Bash", input: { command: "sleep 1" } } as never,
    { status: "backgrounded", backgroundTaskId: "bash_legacy" },
    traceContext,
    undefined,
  );
  assert.deepEqual(eventTypes, ["background_task_started", "background_task_completed"]);
});

test("legacy profile background frontmatter is diagnosed instead of launching", () => {
  const result = parseAgentProfileFromMarkdown({
    source: "user",
    content: [
      "---",
      "name: legacy-background",
      "description: legacy profile",
      "background: true",
      "---",
      "Work in the foreground.",
    ].join("\n"),
  });

  assert.equal(result.profile, undefined);
  assert.equal(result.diagnostic?.code, "agent_background_forbidden");
});
