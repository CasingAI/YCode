import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// handlers/index.js 必须先进来：goal-compact → session-flow → prompt-turn 的既有循环
// 依赖 barrel 先完成 handler 表初始化（与 goalCommandModeGate.test.ts 同款约束）。
import "../src/zcode-protocol-v4/commands/handlers/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import { startManualCompact } from "../src/zcode-protocol-v4/commands/handlers/goal-compact.js";
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import { inputIntentMetadataFromQueueItem } from "../src/zcode-protocol-v4/commands/input-intent.js";
import {
  listProtocolSlashCommands,
  readBuiltinCommandModelSelectionOverrides,
} from "../src/zcode-protocol/slash-commands.js";

// 命令绑定模型（docs/specs/command-model-binding.md）CLI 侧只执行发送端声明：
// 「是否仅本轮」由 UI 按插入锁定的着色快照判定，随 payload 下发、经队列 intent
// 原样提升，执行侧不再开跑现读配置推导。这里覆盖透传链条与目录投影两条边界。

const BINDING = { providerId: "zcode", modelId: "glm-5.3" };

async function withRedirectedHome(run: () => Promise<void>) {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "command-model-binding-"));
  process.env.HOME = home;
  try {
    await run();
  } finally {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

async function writeUserConfig(home: string, config: Record<string, unknown>) {
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(join(home, ".zcode", "cli", "config.json"), JSON.stringify(config));
}

test("readBuiltinCommandModelSelectionOverrides：读取用户配置的 builtinCommands 段", async () => {
  await withRedirectedHome(async () => {
    await writeUserConfig(process.env.HOME!, {
      builtinCommands: { compact: { model: BINDING } },
    });
    const overrides = await readBuiltinCommandModelSelectionOverrides();
    assert.deepEqual(overrides.get("compact"), BINDING);
    assert.equal(overrides.has("init"), false);
  });
});

test("readBuiltinCommandModelSelectionOverrides：坏条目静默丢弃，不阻断其余绑定", async () => {
  await withRedirectedHome(async () => {
    await writeUserConfig(process.env.HOME!, {
      builtinCommands: {
        compact: { model: BINDING },
        broken: { model: "no-slash-model" },
      },
    });
    const overrides = await readBuiltinCommandModelSelectionOverrides();
    assert.deepEqual(overrides.get("compact"), BINDING);
    assert.equal(overrides.has("broken"), false);
  });
});

interface CompactHarness {
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  submitOptions: Array<Record<string, unknown>>;
}

/** 非 busy 路径的最小替身：submitPrompt 只记录参数，compact 后台轮立即走完。 */
function buildCompactHarness(): CompactHarness {
  const submitOptions: Array<Record<string, unknown>> = [];
  const record = {
    app: {
      sessionId: "compact-binding",
      submitPrompt: async (_text: string, options: Record<string, unknown>) => {
        submitOptions.push(options);
      },
      setQueueAutoDrain: async () => {},
      runtime: {
        getActiveTurnInfo: () => undefined,
        releaseForegroundPromotionLease: () => {},
      },
    },
    workspace: { workspacePath: "/tmp/workspace" },
  } as unknown as V4SessionRecordView;
  const host = {
    getRecord: (sessionId: string) => (sessionId === "compact-binding" ? record : undefined),
    ensureModelReady: async () => {},
  } as unknown as V4CommandCoreHost;
  return { host, record, submitOptions };
}

/** 后台 compact 轮是 detached runner：轮询到 submitPrompt 被调用为止。 */
async function waitForSubmit(submitOptions: Array<Record<string, unknown>>) {
  for (let i = 0; i < 20 && submitOptions.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(submitOptions.length, 1, "compact 后台轮应恰好提交一次 prompt");
}

test("compact：payload 声明仅本轮 → submitPrompt 原样透传 modelExecution", async () => {
  const harness = buildCompactHarness();
  await NATIVE_HANDLERS.compact(harness.host, {
    commandId: "cmd-1",
    sessionId: "compact-binding",
    payload: {
      modelSelection: BINDING,
      modelExecution: { selectionScope: "execution" },
    },
  } as never);
  await waitForSubmit(harness.submitOptions);
  const options = harness.submitOptions[0]!;
  assert.deepEqual(options.modelExecution, { selectionScope: "execution" });
  assert.deepEqual((options.intent as Record<string, unknown>).modelExecution, {
    selectionScope: "execution",
  });
});

test("compact：payload 未声明（如上下文栏入口）→ 不带 modelExecution，走会话模型写回", async () => {
  const harness = buildCompactHarness();
  await NATIVE_HANDLERS.compact(harness.host, {
    commandId: "cmd-2",
    sessionId: "compact-binding",
    payload: {},
  } as never);
  await waitForSubmit(harness.submitOptions);
  const options = harness.submitOptions[0]!;
  assert.equal(options.modelExecution, undefined);
});

test("队列提升：intent 声明仅本轮 → startManualCompact 原样带回，不重新推导", async () => {
  const harness = buildCompactHarness();
  await startManualCompact(
    harness.host,
    harness.record,
    "cmd-3",
    undefined,
    // 队列提升产物（inputIntentMetadataFromQueueItem 的输出形态）。
    { kind: "compact", text: "/compact", modelExecution: { selectionScope: "execution" } } as never,
  );
  await waitForSubmit(harness.submitOptions);
  assert.deepEqual(harness.submitOptions[0]!.modelExecution, { selectionScope: "execution" });
});

test("队列提升：inputIntentMetadataFromQueueItem 保留 modelExecution 声明", () => {
  const intent = inputIntentMetadataFromQueueItem(
    {
      sourceCommandId: "cmd-4",
      queueItemId: "q-1",
      clientId: "cli",
      kind: "compact",
      modelSelection: BINDING,
      modelExecution: { selectionScope: "execution" },
      order: { admissionSeq: 1, queuePosition: 0 },
      admittedAt: 0,
      delivery: { requested: "queue", admitted: "queue" },
      attachments: [],
    } as never,
    "/compact",
  );
  assert.deepEqual(intent.modelExecution, { selectionScope: "execution" });
});

test("队列提升：无 modelExecution 的队列项不产字段", () => {
  const intent = inputIntentMetadataFromQueueItem(
    {
      sourceCommandId: "cmd-5",
      queueItemId: "q-2",
      clientId: "cli",
      kind: "compact",
      order: { admissionSeq: 1, queuePosition: 0 },
      admittedAt: 0,
      delivery: { requested: "queue", admitted: "queue" },
      attachments: [],
    } as never,
    "/compact",
  );
  assert.equal(intent.modelExecution, undefined);
});

test("sendText：payload 声明仅本轮 → 冻结进 intent，busy 入队后仍能原样提升", async () => {
  // 回归防线：命令着色的 sendText 带 modelExecution 走 Core admission，busy 时必须
  // 入队（旧的「带声明即拒单」会把发送变成失败），且 intent 必须带上声明，否则
  // 队列项只剩 modelSelection，提升后按会话模型跑并写回，绑定静默失效。
  const sendOptions: Array<Record<string, unknown>> = [];
  const record = {
    app: {
      sessionId: "send-binding",
      sendInput: async (_input: unknown, options: Record<string, unknown>) => {
        sendOptions.push(options);
        return { kind: "queued" as const, queueLength: 1 };
      },
      runtime: {
        getSessionModelSelection: () => undefined,
        getActiveTurnInfo: () => undefined,
        releaseForegroundPromotionLease: () => {},
      },
      getModel: () => `${BINDING.providerId}/${BINDING.modelId}`,
    },
    workspace: { workspacePath: "/tmp/workspace" },
  } as unknown as V4SessionRecordView;
  const host = {
    getRecord: (sessionId: string) => (sessionId === "send-binding" ? record : undefined),
    ensureModelReady: async () => {},
    getInputRoutingMode: () => "enqueue",
  } as unknown as V4CommandCoreHost;

  const result = await NATIVE_HANDLERS.sendText(host, {
    commandId: "cmd-6",
    sessionId: "send-binding",
    payload: {
      text: "/test-hello",
      modelSelection: BINDING,
      modelExecution: { selectionScope: "execution" },
    },
  } as never);

  assert.equal(result?.type, "inputAccepted");
  assert.equal(sendOptions.length, 1);
  const intent = sendOptions[0]!.intent as Record<string, unknown>;
  // 声明既进 admission 顶层参数（当轮生效），也进 intent（跨队列提升存活）。
  assert.deepEqual(sendOptions[0]!.modelExecution, { selectionScope: "execution" });
  assert.deepEqual(intent.modelExecution, { selectionScope: "execution" });
  assert.deepEqual(intent.modelSelection, BINDING);
});

test("sendText：未声明仅本轮 → intent 不产 modelExecution 字段", async () => {
  const sendOptions: Array<Record<string, unknown>> = [];
  const record = {
    app: {
      sessionId: "send-binding-plain",
      sendInput: async (_input: unknown, options: Record<string, unknown>) => {
        sendOptions.push(options);
        return { kind: "queued" as const, queueLength: 1 };
      },
      runtime: {
        getSessionModelSelection: () => undefined,
        getActiveTurnInfo: () => undefined,
        releaseForegroundPromotionLease: () => {},
      },
      getModel: () => `${BINDING.providerId}/${BINDING.modelId}`,
    },
    workspace: { workspacePath: "/tmp/workspace" },
  } as unknown as V4SessionRecordView;
  const host = {
    getRecord: (sessionId: string) => (sessionId === "send-binding-plain" ? record : undefined),
    ensureModelReady: async () => {},
    getInputRoutingMode: () => "enqueue",
  } as unknown as V4CommandCoreHost;

  await NATIVE_HANDLERS.sendText(host, {
    commandId: "cmd-7",
    sessionId: "send-binding-plain",
    payload: { text: "普通消息", modelSelection: BINDING },
  } as never);

  const intent = sendOptions[0]!.intent as Record<string, unknown>;
  assert.equal(intent.modelExecution, undefined);
  assert.equal(sendOptions[0]!.modelExecution, undefined);
});

test("sendText 队列提升：冻结的声明回填 startPromptTurn 顶层参数", async () => {
  // 回归防线：startPromptTurn 的模型闸门与 Core admission 读的是顶层 modelExecution，
  // 只留在 intent 里会让提升后的 turn 按会话模型跑。
  const sendOptions: Array<Record<string, unknown>> = [];
  const record = {
    app: {
      sessionId: "send-promote",
      sendInput: async (_input: unknown, options: Record<string, unknown>) => {
        sendOptions.push(options);
        return { kind: "started" as const, turnId: "turn-1", completion: Promise.resolve() };
      },
      reserveQueueItem: async () => true,
      markQueueItemPromoting: async () => true,
      removeQueueItem: async () => true,
      runtime: {
        getSessionModelSelection: () => undefined,
        getActiveTurnInfo: () => undefined,
        acquireForegroundPromotionLease: () => ({ kind: "acquired" as const }),
        releaseForegroundPromotionLease: () => {},
      },
      getModel: () => `${BINDING.providerId}/${BINDING.modelId}`,
    },
    workspace: { workspacePath: "/tmp/workspace" },
  } as unknown as V4SessionRecordView;
  const queueItem = {
    sourceCommandId: "cmd-8",
    queueItemId: "q-3",
    clientId: "cli",
    kind: "sendText",
    text: "/test-hello",
    modelSelection: BINDING,
    modelExecution: { selectionScope: "execution" },
    order: { admissionSeq: 1, queuePosition: 0 },
    admittedAt: 0,
    delivery: { requested: "queue", admitted: "queue" },
    attachments: [],
    dispatch: { state: "reserved" },
    steer: { state: "notRequested" },
  };
  const host = {
    getRecord: (sessionId: string) => (sessionId === "send-promote" ? record : undefined),
    ensureModelReady: async () => {},
    getQueueItem: () => queueItem,
  } as unknown as V4CommandCoreHost;

  await NATIVE_HANDLERS.sendQueuedNow(host, {
    commandId: "cmd-8",
    sessionId: "send-promote",
    payload: { queueItemId: "q-3" },
  } as never);

  assert.equal(sendOptions.length, 1);
  assert.deepEqual(sendOptions[0]!.modelExecution, { selectionScope: "execution" });
});

test("目录投影：zcode 来源的文件头绑定照常投影", async () => {
  await withRedirectedHome(async () => {
    const home = process.env.HOME!;
    const workdir = join(home, "work");
    await mkdir(join(home, ".zcode", "commands"), { recursive: true });
    await mkdir(workdir, { recursive: true });
    await writeFile(
      join(home, ".zcode", "commands", "bound.md"),
      `---\ndescription: bound\nmodel: ${BINDING.providerId}/${BINDING.modelId}\n---\nbody`,
    );
    const commands = await listProtocolSlashCommands({ workingDirectory: workdir });
    const bound = commands.find((command) => command.name === "bound");
    assert.ok(bound, "zcode 目录命令应进入装配目录");
    assert.deepEqual(bound!.modelSelectionOverride, BINDING);
  });
});

test("目录投影：非 zcode 来源（agents 外部导入）不投影绑定，避免着色无控件可解除", async () => {
  await withRedirectedHome(async () => {
    const home = process.env.HOME!;
    const workdir = join(home, "work");
    await mkdir(join(home, ".agents", "commands"), { recursive: true });
    await mkdir(workdir, { recursive: true });
    await writeFile(
      join(home, ".agents", "commands", "imported.md"),
      `---\ndescription: imported\nmodel: ${BINDING.providerId}/${BINDING.modelId}\n---\nbody`,
    );
    const commands = await listProtocolSlashCommands({ workingDirectory: workdir });
    const imported = commands.find((command) => command.name === "imported");
    assert.ok(imported, "agents 目录命令应进入装配目录");
    assert.equal(imported!.modelSelectionOverride, undefined);
  });
});

test("目录投影：init 存量绑定不再投影（强制跟随默认，只是不再生效）", async () => {
  await withRedirectedHome(async () => {
    await writeUserConfig(process.env.HOME!, {
      builtinCommands: {
        compact: { model: BINDING },
        init: { model: BINDING },
      },
    });
    const commands = await listProtocolSlashCommands({
      workingDirectory: join(process.env.HOME!, "work"),
    });
    const compact = commands.find((command) => command.name === "compact");
    assert.ok(compact, "compact 应进入装配目录");
    assert.deepEqual(compact!.modelSelectionOverride, BINDING);
    const init = commands.find((command) => command.name === "init");
    assert.ok(init, "init 应进入装配目录");
    assert.equal(init!.modelSelectionOverride, undefined);
  });
});
