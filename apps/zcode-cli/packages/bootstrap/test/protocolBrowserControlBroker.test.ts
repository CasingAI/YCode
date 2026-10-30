// 子代理 own-tabs 授权：Protocol browser broker 回归验收。
// 覆盖 docs/specs/subagent-browser-use-delegation.md 的授权矩阵、grant 生命周期、
// 父 record 路由、命令限制、并发 child 隔离，以及主代理路径保持不变。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  BrowserCommandResult,
  SubagentBrowserDelegationGrant,
  SubagentExecutionFence,
} from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createProtocolBrowserControlBroker } from "../src/zcode-protocol/browser-control-broker.js";

const PARENT_A = "parent-a";
const PARENT_B = "parent-b";
const CHILD_1 = "child-1";
const CHILD_2 = "child-2";
const CHILD_3 = "child-3";
const WORKSPACE_A = {
  workspacePath: "/workspace/a",
  workspaceIdentity: "workspace-a",
  remoteSessionId: "remote-a",
};
const WORKSPACE_B = {
  workspacePath: "/workspace/b",
  workspaceIdentity: "workspace-b",
  remoteSessionId: "remote-b",
};

interface CapturedRequest {
  method: string;
  params: Record<string, any>;
  options: { signal?: AbortSignal } | undefined;
}

function createHarness(options?: {
  requestClient?: (
    method: string,
    params: Record<string, any>,
    options: { signal?: AbortSignal } | undefined,
  ) => Promise<unknown>;
}) {
  const sessions = new Map<string, any>([
    [PARENT_A, createSessionRecord(WORKSPACE_A, "desktop-continuous")],
    [PARENT_B, createSessionRecord(WORKSPACE_B, "web-remote-replayable")],
  ]);
  const requests: CapturedRequest[] = [];
  const context = {
    deps: {},
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoRecordingEnabled: false,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
      automationEnabled: false,
      webSearchEnabled: false,
    },
    v4Interactions: {},
    sessions,
    notify: () => undefined,
    requestClient: async (
      method: string,
      params: Record<string, any>,
      _schema: unknown,
      requestOptions?: { signal?: AbortSignal },
    ) => {
      requests.push({ method, params, options: requestOptions });
      if (options?.requestClient) {
        return await options.requestClient(method, params, requestOptions);
      }
      if (method === "interaction/browserList") {
        return { browsers: [] };
      }
      return { ok: true, elapsedMs: 1 } satisfies BrowserCommandResult;
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, sessions, requests };
}

function createSessionRecord(workspace: Record<string, string>, deliveryKind?: string): any {
  return {
    createdAt: 0,
    updatedAt: 0,
    stateRevision: 0,
    workspace,
    ...(deliveryKind ? { deliveryKind } : {}),
  };
}

function createFence(childSessionId: string, fencingEpoch: number): SubagentExecutionFence {
  return { childSessionId, fencingEpoch, ownerRuntimeId: "owner-runtime-1" };
}

/** 可控 defer：让权威校验停在 pending，期间修改 broker 表或父 record。 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 校验器进入 pending 的信号，测试据此在 await 窗口内制造竞态。 */
function pendingValidator(): {
  validate: (fence: SubagentExecutionFence) => Promise<boolean>;
  entered: Promise<void>;
  resolve: (value: boolean) => void;
} {
  const gate = deferred<boolean>();
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  return {
    validate: async () => {
      markEntered();
      return await gate.promise;
    },
    entered,
    resolve: gate.resolve,
  };
}

function grantFor(
  context: ZCodeProtocolAgentServerContext,
  input: {
    parentSessionId?: string;
    childSessionId?: string;
    agentId?: string;
    fencingEpoch?: number;
    parentTurnId?: string;
    validateExecutionFence?: (fence: SubagentExecutionFence) => Promise<boolean>;
  } = {},
): SubagentBrowserDelegationGrant {
  const delegation = createProtocolBrowserControlBroker(context).subagentDelegation;
  assert.ok(delegation, "Protocol broker must expose subagentDelegation");
  const childSessionId = input.childSessionId ?? CHILD_1;
  return delegation.grant({
    parentSessionId: input.parentSessionId ?? PARENT_A,
    childSessionId,
    agentId: input.agentId ?? "agent-1",
    executionFence: createFence(childSessionId, input.fencingEpoch ?? 1),
    ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
    ...(input.validateExecutionFence
      ? { validateExecutionFence: input.validateExecutionFence }
      : {}),
  });
}

test("grant 快照父 active record，authorize 同时校验 grantId 与 childSessionId", () => {
  const { context } = createHarness();
  const grant = grantFor(context, { parentTurnId: "turn-1" });

  assert.match(grant.grantId, /^[0-9a-f-]{36}$/iu);
  assert.equal(grant.parentSessionId, PARENT_A);
  assert.equal(grant.childSessionId, CHILD_1);
  assert.equal(grant.agentId, "agent-1");
  assert.deepEqual(grant.executionFence, createFence(CHILD_1, 1));
  assert.equal(grant.parentTurnId, "turn-1");
  assert.equal(grant.workspaceKey, "workspace-a");
  assert.equal(grant.workspacePath, "/workspace/a");
  assert.equal(grant.workspaceIdentity, "workspace-a");
  assert.equal(grant.remoteSessionId, "remote-a");
  assert.equal(grant.clientMode, "desktop-continuous");
  assert.equal(typeof grant.issuedAt, "number");

  const delegation = createProtocolBrowserControlBroker(context).subagentDelegation!;
  assert.deepEqual(
    delegation.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }),
    grant,
  );
  assert.equal(
    delegation.authorize({ grantId: grant.grantId, childSessionId: CHILD_2 }),
    undefined,
  );
  assert.equal(delegation.authorize({ grantId: "unknown", childSessionId: CHILD_1 }), undefined);
});

test("同一 child 新执行签发后旧 grant 立即失效；旧 revoke 不能删除新 grant", () => {
  const { context } = createHarness();
  const delegation = createProtocolBrowserControlBroker(context).subagentDelegation!;
  const first = delegation.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_1,
    agentId: "agent-1",
    executionFence: createFence(CHILD_1, 1),
  });
  const second = delegation.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_1,
    agentId: "agent-1",
    executionFence: createFence(CHILD_1, 2),
  });

  assert.notEqual(first.grantId, second.grantId);
  assert.equal(
    delegation.authorize({ grantId: first.grantId, childSessionId: CHILD_1 }),
    undefined,
  );
  assert.deepEqual(
    delegation.authorize({ grantId: second.grantId, childSessionId: CHILD_1 }),
    second,
  );

  // 旧执行迟到的 revoke：grantId + child + fence 都不匹配新 grant，必须不能误删。
  delegation.revoke({
    grantId: first.grantId,
    childSessionId: CHILD_1,
    executionFence: first.executionFence,
  });
  assert.deepEqual(
    delegation.authorize({ grantId: second.grantId, childSessionId: CHILD_1 }),
    second,
  );
});

test("旧 fence 的 grant 迟到不能重新激活新执行授权（含新执行已 revoke 后）", () => {
  const { context } = createHarness();
  const delegation = createProtocolBrowserControlBroker(context).subagentDelegation!;
  const newer = delegation.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_1,
    agentId: "agent-1",
    executionFence: createFence(CHILD_1, 2),
  });

  // 旧执行（epoch 1）晚到签发：工具 dispatch 没有逐次 claim 校验，若不比较 fence，
  // 它会删除并替换 epoch 2 的 grant，让被接管的旧执行重新获得浏览器授权。
  assert.throws(
    () =>
      delegation.grant({
        parentSessionId: PARENT_A,
        childSessionId: CHILD_1,
        agentId: "agent-1",
        executionFence: createFence(CHILD_1, 1),
      }),
    /stale/iu,
  );
  assert.deepEqual(
    delegation.authorize({ grantId: newer.grantId, childSessionId: CHILD_1 }),
    newer,
    "late old grant must not replace the newer grant",
  );

  delegation.revoke({
    grantId: newer.grantId,
    childSessionId: CHILD_1,
    executionFence: newer.executionFence,
  });
  // revoke 不能降低水位：新执行结束后，旧执行迟到签发仍必须被拒绝。
  assert.throws(
    () =>
      delegation.grant({
        parentSessionId: PARENT_A,
        childSessionId: CHILD_1,
        agentId: "agent-1",
        executionFence: createFence(CHILD_1, 1),
      }),
    /stale/iu,
  );
  assert.equal(
    delegation.authorize({ grantId: newer.grantId, childSessionId: CHILD_1 }),
    undefined,
    "watermark is not an authorization",
  );

  // 更高代际仍可正常签发。
  const next = delegation.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_1,
    agentId: "agent-1",
    executionFence: createFence(CHILD_1, 3),
  });
  assert.deepEqual(delegation.authorize({ grantId: next.grantId, childSessionId: CHILD_1 }), next);
});

test("同一代际同 owner 可重签发；不同 owner 视为 fence 冲突", () => {
  const { context } = createHarness();
  const delegation = createProtocolBrowserControlBroker(context).subagentDelegation!;
  const first = delegation.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_1,
    agentId: "agent-1",
    executionFence: createFence(CHILD_1, 2),
  });
  // 同一次执行的重试签发：允许，并让上一个 grantId 失效。
  const retry = delegation.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_1,
    agentId: "agent-1",
    executionFence: createFence(CHILD_1, 2),
  });
  assert.notEqual(first.grantId, retry.grantId);
  assert.equal(
    delegation.authorize({ grantId: first.grantId, childSessionId: CHILD_1 }),
    undefined,
  );
  assert.deepEqual(
    delegation.authorize({ grantId: retry.grantId, childSessionId: CHILD_1 }),
    retry,
  );

  assert.throws(
    () =>
      delegation.grant({
        parentSessionId: PARENT_A,
        childSessionId: CHILD_1,
        agentId: "agent-1",
        executionFence: { ...createFence(CHILD_1, 2), ownerRuntimeId: "another-owner" },
      }),
    /conflicts/iu,
  );
  assert.deepEqual(
    delegation.authorize({ grantId: retry.grantId, childSessionId: CHILD_1 }),
    retry,
    "conflicting owner must not replace the accepted grant",
  );
});

test("不同 Protocol context 的 grant 表互相隔离", () => {
  const first = createHarness();
  const second = createHarness();
  const grant = grantFor(first.context);
  const secondDelegation = createProtocolBrowserControlBroker(second.context).subagentDelegation!;

  assert.equal(
    secondDelegation.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }),
    undefined,
  );
  assert.deepEqual(
    createProtocolBrowserControlBroker(first.context).subagentDelegation!.authorize({
      grantId: grant.grantId,
      childSessionId: CHILD_1,
    }),
    grant,
  );
});

test("revoke 幂等且只删除 grantId/child/fence 完全匹配的 grant", () => {
  const { context } = createHarness();
  const delegation = createProtocolBrowserControlBroker(context).subagentDelegation!;
  const grant = delegation.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_1,
    agentId: "agent-1",
    executionFence: createFence(CHILD_1, 1),
  });

  delegation.revoke({
    grantId: grant.grantId,
    childSessionId: CHILD_2,
    executionFence: grant.executionFence,
  });
  assert.ok(delegation.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }));

  delegation.revoke({
    grantId: grant.grantId,
    childSessionId: CHILD_1,
    executionFence: createFence(CHILD_1, 99),
  });
  assert.ok(delegation.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }));

  delegation.revoke({
    grantId: grant.grantId,
    childSessionId: CHILD_1,
    executionFence: grant.executionFence,
  });
  assert.equal(
    delegation.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }),
    undefined,
  );
  // 幂等：再次 revoke 不抛错。
  assert.doesNotThrow(() =>
    delegation.revoke({
      grantId: grant.grantId,
      childSessionId: CHILD_1,
      executionFence: grant.executionFence,
    }),
  );
});

test("父 session 失活后 authorize 拒绝，list/execute 返回稳定不可用错误", async () => {
  const { context, sessions } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  const grant = grantFor(context);
  sessions.delete(PARENT_A);

  assert.equal(
    port.subagentDelegation!.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }),
    undefined,
  );
  await assert.rejects(
    port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId }),
    /not available/iu,
  );
  await assert.rejects(
    port.execute({
      browserId: "browser-a",
      browserGeneration: 1,
      sessionId: CHILD_1,
      delegationGrantId: grant.grantId,
      command: { method: "navigate", url: "https://example.com" },
    }),
    /not available/iu,
  );
});

test("父 record 的 workspace/remote/delivery 快照漂移后 grant 不再生效", async () => {
  const drifts: Array<{ name: string; mutate: (record: any) => void }> = [
    {
      name: "workspacePath",
      mutate: (record) => {
        record.workspace = { ...record.workspace, workspacePath: "/workspace/other" };
      },
    },
    {
      name: "workspaceIdentity",
      mutate: (record) => {
        record.workspace = { ...record.workspace, workspaceIdentity: "other-identity" };
      },
    },
    {
      name: "remoteSessionId",
      mutate: (record) => {
        record.workspace = { ...record.workspace, remoteSessionId: "other-remote" };
      },
    },
    {
      name: "deliveryKind",
      mutate: (record) => {
        record.deliveryKind = "web-remote-replayable";
      },
    },
  ];

  for (const drift of drifts) {
    const { context, sessions } = createHarness();
    const port = createProtocolBrowserControlBroker(context);
    const grant = grantFor(context);
    drift.mutate(sessions.get(PARENT_A));

    assert.equal(
      port.subagentDelegation!.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }),
      undefined,
      `identity drift ${drift.name} must deny`,
    );
    await assert.rejects(
      port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId }),
      /not available/iu,
      `list must deny on ${drift.name} drift`,
    );
  }
});

test("带 grant 的 list/execute 用父 record 路由 workspace，但保留 child sessionId", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  const grant = grantFor(context);

  await port.list({ sessionId: CHILD_1, turnId: "turn-1", delegationGrantId: grant.grantId });
  const listRequest = requests.at(-1)!;
  assert.equal(listRequest.method, "interaction/browserList");
  assert.equal(listRequest.params.sessionId, CHILD_1);
  assert.equal(listRequest.params.workspacePath, "/workspace/a");
  assert.equal(listRequest.params.workspaceKey, "workspace-a");
  assert.equal(listRequest.params.workspaceIdentity, "workspace-a");
  assert.equal(listRequest.params.remoteSessionId, "remote-a");
  assert.equal(listRequest.params.clientMode, "desktop-continuous");
  assert.equal(listRequest.params.turnId, "turn-1");

  await port.execute({
    browserId: "browser-a",
    browserGeneration: 7,
    sessionId: CHILD_1,
    delegationGrantId: grant.grantId,
    command: { method: "newTab" },
  });
  const executeRequest = requests.at(-1)!;
  assert.equal(executeRequest.method, "interaction/browserExecute");
  assert.equal(executeRequest.params.sessionId, CHILD_1);
  assert.equal(executeRequest.params.workspacePath, "/workspace/a");
  assert.equal(executeRequest.params.remoteSessionId, "remote-a");
  assert.equal(executeRequest.params.browserId, "browser-a");
  assert.equal(executeRequest.params.browserGeneration, 7);
  assert.deepEqual(executeRequest.params.command, { method: "newTab" });
});

test("子代理越界命令在 broker 拒绝，不触达 Main", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  const grant = grantFor(context);

  const deniedCommands = [
    { method: "listUserTabs" },
    { method: "claimTab", tabId: "tab-parent" },
    { method: "browserVisibilitySet", visible: true },
    { method: "turnEnded" },
    { method: "closeSession" },
  ] as const;

  for (const command of deniedCommands) {
    await assert.rejects(
      port.execute({
        browserId: "browser-a",
        browserGeneration: 1,
        sessionId: CHILD_1,
        delegationGrantId: grant.grantId,
        command,
      }),
      /not available/iu,
      `${command.method} must be denied`,
    );
  }
  assert.equal(requests.length, 0, "denied child commands must not reach Main");
});

test("主代理路径保持原样：不带 grant 时不查授权表也不限制命令", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);

  await port.list({ sessionId: PARENT_A });
  assert.equal(requests.at(-1)!.params.sessionId, PARENT_A);
  assert.equal(requests.at(-1)!.params.workspacePath, "/workspace/a");

  await port.execute({
    browserId: "browser-a",
    browserGeneration: 3,
    sessionId: PARENT_A,
    command: { method: "listUserTabs" },
  });
  assert.equal(requests.at(-1)!.params.sessionId, PARENT_A);
  assert.deepEqual(requests.at(-1)!.params.command, { method: "listUserTabs" });
});

test("两个 child 并发：grant 互不失效，交叉 child 不能授权", async () => {
  const { context, requests } = createHarness();
  const delegation = createProtocolBrowserControlBroker(context).subagentDelegation!;
  const first = delegation.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_1,
    agentId: "agent-1",
    executionFence: createFence(CHILD_1, 1),
  });
  const second = delegation.grant({
    parentSessionId: PARENT_B,
    childSessionId: CHILD_2,
    agentId: "agent-2",
    executionFence: createFence(CHILD_2, 1),
  });

  assert.deepEqual(
    delegation.authorize({ grantId: first.grantId, childSessionId: CHILD_1 }),
    first,
  );
  assert.deepEqual(
    delegation.authorize({ grantId: second.grantId, childSessionId: CHILD_2 }),
    second,
  );
  assert.equal(
    delegation.authorize({ grantId: first.grantId, childSessionId: CHILD_2 }),
    undefined,
  );
  assert.equal(
    delegation.authorize({ grantId: second.grantId, childSessionId: CHILD_1 }),
    undefined,
  );

  const port = createProtocolBrowserControlBroker(context);
  await port.list({ sessionId: CHILD_2, delegationGrantId: second.grantId });
  const routed = requests.at(-1)!;
  assert.equal(routed.params.sessionId, CHILD_2);
  assert.equal(routed.params.workspacePath, "/workspace/b");
  assert.equal(routed.params.workspaceIdentity, "workspace-b");
  assert.equal(routed.params.clientMode, "web-remote-replayable");
});

test("子执行取消：沿用 signal 取消在途带 grant 的请求并发送 cancelRequest", async () => {
  let executeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    executeStarted = resolve;
  });
  const { context, requests } = createHarness({
    requestClient: async (_method, params, options) => {
      if (params.command?.method === "cancelRequest") {
        return { ok: true, elapsedMs: 0 };
      }
      executeStarted?.();
      return await new Promise((resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  const port = createProtocolBrowserControlBroker(context);
  const grant = grantFor(context);
  const controller = new AbortController();

  const pending = port.execute({
    browserId: "browser-a",
    browserGeneration: 1,
    sessionId: CHILD_1,
    delegationGrantId: grant.grantId,
    command: { method: "navigate", url: "https://example.com" },
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(pending, /abort/iu);

  const mainRequest = requests[0]!;
  const cancelRequest = requests.find(
    (request) => request.params.command?.method === "cancelRequest",
  );
  assert.ok(cancelRequest, "abort must send an internal cancelRequest");
  assert.equal(cancelRequest.params.sessionId, CHILD_1);
  assert.equal(cancelRequest.params.command.requestId, mainRequest.params.requestId);
  assert.equal(cancelRequest.params.workspacePath, "/workspace/a");
});

test("同一 Protocol context 的多个 broker 实例共享同一张 grant 表", async () => {
  const { context } = createHarness();
  // server.browserControlPort（node_repl 侧）与 session app runtime 侧是两个实例，
  // grant 必须由 context 唯一持有，否则签发与授权会落在不同表里。
  const runtimePort = createProtocolBrowserControlBroker(context);
  const nodeReplPort = createProtocolBrowserControlBroker(context);
  const grant = runtimePort.subagentDelegation!.grant({
    parentSessionId: PARENT_A,
    childSessionId: CHILD_3,
    agentId: "agent-3",
    executionFence: createFence(CHILD_3, 1),
  });

  assert.deepEqual(
    nodeReplPort.subagentDelegation!.authorize({ grantId: grant.grantId, childSessionId: CHILD_3 }),
    grant,
  );
});

test("权威 claim 校验：新 epoch 接管但新执行尚未 grant 时，旧 grant 的 list/execute 都拒绝", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  let claimValid = true;
  const grant = grantFor(context, {
    validateExecutionFence: async () => claimValid,
  });

  await port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId });
  assert.equal(requests.length, 1, "claim 有效时正常下发");

  // 模拟 SessionStore 新执行以更高 epoch 接管，且新执行没有 Browser Use / 尚未签发 grant。
  // broker 内存水位仍停在这个旧 grant，只有权威 claim 校验能发现它已失效。
  claimValid = false;
  await assert.rejects(
    port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId }),
    /not available/iu,
  );
  assert.equal(requests.length, 1, "失效 grant 不得触达 Main");
  await assert.rejects(
    port.execute({
      browserId: "browser-a",
      browserGeneration: 1,
      sessionId: CHILD_1,
      delegationGrantId: grant.grantId,
      command: { method: "newTab" },
    }),
    /not available/iu,
  );
  assert.equal(requests.length, 1, "execute 同样不得触达 Main");
  assert.equal(
    port.subagentDelegation!.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }),
    undefined,
    "权威校验失败后 grant 立即从表中删除",
  );

  // claim “恢复”也不能复活已删除的 grant：授权已被权威事实否决过。
  claimValid = true;
  await assert.rejects(
    port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId }),
    /not available/iu,
  );
  assert.equal(requests.length, 1);
});

test("权威 claim 校验：正常执行成功；终态 release 后拒绝；revoke 后不再调用校验器", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  let claimValid = true;
  let validateCalls = 0;
  const seenFences: SubagentExecutionFence[] = [];
  const grant = grantFor(context, {
    validateExecutionFence: async (fence) => {
      validateCalls += 1;
      seenFences.push(fence);
      return claimValid;
    },
  });

  await port.execute({
    browserId: "browser-a",
    browserGeneration: 1,
    sessionId: CHILD_1,
    delegationGrantId: grant.grantId,
    command: { method: "newTab" },
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(seenFences, [grant.executionFence], "校验器收到 grant 自己的 fence");

  // SessionStore 终态 release：claim 行仍在但 expires_at=0，renew 返回 false。
  claimValid = false;
  await assert.rejects(
    port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId }),
    /not available/iu,
  );
  assert.equal(requests.length, 1);

  const callsAfterRelease = validateCalls;
  port.subagentDelegation!.revoke({
    grantId: grant.grantId,
    childSessionId: CHILD_1,
    executionFence: grant.executionFence,
  });
  await assert.rejects(
    port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId }),
    /not available/iu,
  );
  assert.equal(validateCalls, callsAfterRelease, "已撤销的 grant 不再进入权威校验");
});

test("权威 claim 校验异常按拒绝处理，不回落内存授权", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  const grant = grantFor(context, {
    validateExecutionFence: async () => {
      throw new Error("database is closed");
    },
  });

  await assert.rejects(
    port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId }),
    /not available/iu,
  );
  assert.equal(requests.length, 0);
  assert.equal(
    port.subagentDelegation!.authorize({ grantId: grant.grantId, childSessionId: CHILD_1 }),
    undefined,
  );
});

test("权威校验 pending 时 grant 被撤销：即使校验返回 true 也不派发", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  const validator = pendingValidator();
  const grant = grantFor(context, { validateExecutionFence: validator.validate });

  const pending = port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId });
  await validator.entered;
  port.subagentDelegation!.revoke({
    grantId: grant.grantId,
    childSessionId: CHILD_1,
    executionFence: grant.executionFence,
  });
  validator.resolve(true);

  await assert.rejects(pending, /not available/iu);
  assert.equal(requests.length, 0, "撤销后不得派发已通过异步校验的旧 route");
});

test("权威校验 pending 时同一 child 签发新 grant：旧请求拒绝，新 grant 可用", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  const validator = pendingValidator();
  const oldGrant = grantFor(context, {
    fencingEpoch: 1,
    validateExecutionFence: validator.validate,
  });

  const pending = port.list({ sessionId: CHILD_1, delegationGrantId: oldGrant.grantId });
  await validator.entered;
  const newGrant = grantFor(context, { fencingEpoch: 2 });
  validator.resolve(true);

  await assert.rejects(pending, /not available/iu);
  assert.equal(requests.length, 0, "旧 grant 被替换后旧请求不得派发");

  await port.list({ sessionId: CHILD_1, delegationGrantId: newGrant.grantId });
  assert.equal(requests.length, 1, "新 grant 仍然可用");
});

test("权威校验 pending 时父 workspace/remote 变化：拒绝", async () => {
  const { context, sessions, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  const validator = pendingValidator();
  const grant = grantFor(context, { validateExecutionFence: validator.validate });

  const pending = port.list({ sessionId: CHILD_1, delegationGrantId: grant.grantId });
  await validator.entered;
  sessions.get(PARENT_A)!.workspace.remoteSessionId = "remote-a2";
  validator.resolve(true);

  await assert.rejects(pending, /not available/iu);
  assert.equal(requests.length, 0, "父 record 快照变化后不得派发");
});

test("权威校验 pending 时 signal 被 abort：原 command 不派发", async () => {
  const { context, requests } = createHarness();
  const port = createProtocolBrowserControlBroker(context);
  const validator = pendingValidator();
  const grant = grantFor(context, { validateExecutionFence: validator.validate });
  const controller = new AbortController();

  const pending = port.execute({
    browserId: "browser-a",
    browserGeneration: 1,
    sessionId: CHILD_1,
    delegationGrantId: grant.grantId,
    command: { method: "navigate", url: "https://example.com" },
    signal: controller.signal,
  });
  await validator.entered;
  controller.abort();
  validator.resolve(true);

  await assert.rejects(pending, /abort/iu);
  assert.equal(requests.length, 0, "abort 后不得真实派发原 command");
});
