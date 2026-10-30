import { randomUUID } from "node:crypto";
import type {
  BrowserClientMode,
  BrowserControlPort,
  BrowserCommandMethod,
  SubagentBrowserDelegationGrant,
  SubagentBrowserDelegationPort,
  SubagentExecutionFence,
  TraceContext,
} from "@zcode/contracts";
import {
  zcodeBrowserExecuteResultSchema,
  zcodeBrowserListResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolClientRequestOptions,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";

/**
 * 子代理越界命令在 broker 就拒绝，不依赖 UI 隐藏 API，也不依赖 Main 的 scope 判断。
 * listUserTabs/claimTab/browserVisibilitySet 会触达父会话或系统焦点；turnEnded/closeSession
 * 属于父会话的浏览器生命周期，child execution 不拥有。
 */
const SUBAGENT_DENIED_BROWSER_METHODS: ReadonlySet<BrowserCommandMethod> = new Set([
  "listUserTabs",
  "claimTab",
  "browserVisibilitySet",
  "turnEnded",
  "closeSession",
]);

/** 稳定的“子代理浏览器不可用”错误；失败路径不回落父权限。 */
export const SUBAGENT_BROWSER_UNAVAILABLE_MESSAGE =
  "Browser is not available for this subagent execution";

/**
 * grant 表的唯一 owner：按 Protocol context 共享。
 *
 * server.browserControlPort（node_repl 侧）与 session app runtime 侧会各自调用
 * createProtocolBrowserControlBroker，但同一 App 的授权事实只能有一份；否则父 runtime
 * 签发的 grant 在 node_repl 侧永远查不到。用 WeakMap 绑定 context 生命周期，不新增持久状态。
 */
/**
 * 内部 registry 视图：对外仍是 `SubagentBrowserDelegationPort`（`grant`/`revoke`/`authorize`
 * 保持同步），额外暴露一个 async 校验给 broker 在 list/execute 下发前 await。
 */
interface SubagentDelegationRegistry extends SubagentBrowserDelegationPort {
  /** 用 grant 签发时注入的权威 claim 校验复核；无校验器时视为通过（仅内存授权）。 */
  validateForRequest(grant: SubagentBrowserDelegationGrant): Promise<boolean>;
}

const delegationByContext = new WeakMap<
  ZCodeProtocolAgentServerContext,
  SubagentDelegationRegistry
>();

function getSubagentDelegation(
  context: ZCodeProtocolAgentServerContext,
): SubagentDelegationRegistry {
  const existing = delegationByContext.get(context);
  if (existing) return existing;
  const created = createSubagentDelegationRegistry(context);
  delegationByContext.set(context, created);
  return created;
}

function createSubagentDelegationRegistry(
  context: ZCodeProtocolAgentServerContext,
): SubagentDelegationRegistry {
  const grants = new Map<string, SubagentBrowserDelegationGrant>();
  /**
   * 每个 grant 的权威执行校验，与 grant 同生命周期删除。它由签发时的可信父 runtime 注入
   * （当前 claim 的 renew）；broker 不自己维护 lease/counter。
   */
  const fenceValidators = new Map<string, (fence: SubagentExecutionFence) => Promise<boolean>>();
  const dropGrant = (grantId: string): void => {
    grants.delete(grantId);
    fenceValidators.delete(grantId);
  };
  /**
   * 每个 child 已见过的最高 fencingEpoch。只用于拒绝迟到的旧执行 grant，不授权、不续期，
   * 也不是 lease：真正的执行代际仍由 SessionStore claim 拥有。revoke 不会降低水位，否则
   * 「新执行结束 → 旧执行迟到签发」会让旧 grant 重新激活。
   */
  const latestFenceByChild = new Map<string, { fencingEpoch: number; ownerRuntimeId: string }>();

  return {
    grant(input) {
      // grant 必须同步：只读当前内存中的可信父 active record。调用方（父 runtime）不能传入
      // workspace/remote/delivery，避免出现第二份事实。
      const parent = requireSession(context, input.parentSessionId, {
        operation: "browserSubagentDelegationGrant",
      });
      if (input.executionFence.childSessionId !== input.childSessionId) {
        // fence 是 SessionStore 对 child 执行代际的事实；错绑会让旧执行拿到新 child 的权限。
        throw new Error("Subagent browser delegation fence does not match child session");
      }
      // 同一 child 的执行代际必须单调递增。工具 dispatch 没有逐次 claim 校验，旧执行在
      // 被新执行接管后仍可能完成剩余初始化并迟到签发 grant；若不比较 fence，旧 grant 会
      // 覆盖新 grant。这里的水位只保证签发顺序，不是授权事实——真正的执行代际仍由
      // SessionStore claim 拥有，list/execute 前还会 await 注入的 claim 校验。
      const latestFence = latestFenceByChild.get(input.childSessionId);
      if (latestFence) {
        if (input.executionFence.fencingEpoch < latestFence.fencingEpoch) {
          throw new Error("Subagent browser delegation grant is stale for this child execution");
        }
        if (
          input.executionFence.fencingEpoch === latestFence.fencingEpoch &&
          input.executionFence.ownerRuntimeId !== latestFence.ownerRuntimeId
        ) {
          // 同一代际只能属于同一个 owner runtime；不同 owner 说明 fence 事实不一致。
          throw new Error(
            "Subagent browser delegation grant conflicts with the current execution fence",
          );
        }
      }
      latestFenceByChild.set(input.childSessionId, {
        fencingEpoch: input.executionFence.fencingEpoch,
        ownerRuntimeId: input.executionFence.ownerRuntimeId,
      });
      // 同一 child 的新 execution 签发后，旧 grant 必须立即失效（旧请求不得继续有效）。
      for (const [grantId, existing] of grants) {
        if (existing.childSessionId === input.childSessionId) {
          dropGrant(grantId);
        }
      }
      const grant: SubagentBrowserDelegationGrant = {
        grantId: randomUUID(),
        parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
        agentId: input.agentId,
        // 复制 fence，避免运行时对象后续变化影响已签发 grant 的匹配语义。
        executionFence: { ...input.executionFence },
        ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
        ...readTrustedWorkspaceSnapshot(parent),
        issuedAt: Date.now(),
      };
      grants.set(grant.grantId, grant);
      if (input.validateExecutionFence) {
        fenceValidators.set(grant.grantId, input.validateExecutionFence);
      }
      return grant;
    },

    revoke({ grantId, childSessionId, executionFence }) {
      const grant = grants.get(grantId);
      if (!grant) return;
      // 只删除三元组完全匹配的 grant：旧执行的迟到 revoke 不能删除新执行签发的 grant。
      if (grant.childSessionId !== childSessionId) return;
      if (!sameExecutionFence(grant.executionFence, executionFence)) return;
      dropGrant(grantId);
    },

    authorize({ grantId, childSessionId }) {
      const grant = grants.get(grantId);
      if (!grant || grant.childSessionId !== childSessionId) return undefined;
      // 父会话失活（close/被回收）后不再授权；但 turn end / UI 关闭 side pane 不撤销 grant，
      // 因此这里只看 session record 是否仍在 active 表中。
      const parent = context.sessions.get(grant.parentSessionId);
      if (!parent) {
        dropGrant(grantId);
        return undefined;
      }
      // 父 record 的 workspace/remote/delivery 与签发快照必须一致：远程 workspace 或 delivery
      // 切换后，旧 grant 不能把 child 页面落到另一份事实里。
      if (!sameWorkspaceSnapshot(grant, readTrustedWorkspaceSnapshot(parent))) {
        return undefined;
      }
      return grant;
    },

    async validateForRequest(grant) {
      const validate = fenceValidators.get(grant.grantId);
      if (!validate) return true;
      // 内存 grant 表不知道 SessionStore 的新 epoch：新执行接管后旧 grant 仍在表里，
      // 终态 release 后 grant 也可能尚未被 revoke。每次真正下发浏览器请求前都 await
      // 权威 claim 校验；异常按拒绝处理，避免存储故障回落成内存授权。
      let valid = false;
      try {
        valid = (await validate(grant.executionFence)) === true;
      } catch {
        valid = false;
      }
      if (!valid) dropGrant(grant.grantId);
      return valid;
    },
  };
}

function readTrustedWorkspaceSnapshot(record: ZCodeProtocolSessionRecord): {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
} {
  const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
  const workspacePath = record.workspace.workspacePath;
  return {
    // 与 Main 的 scopeKey 同一规则：identity 优先，路径仅在本地 workspace 兜底。
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    clientMode: (record.deliveryKind ?? "desktop-continuous") as BrowserClientMode,
  };
}

function sameWorkspaceSnapshot(
  grant: SubagentBrowserDelegationGrant,
  snapshot: ReturnType<typeof readTrustedWorkspaceSnapshot>,
): boolean {
  return (
    grant.workspaceKey === snapshot.workspaceKey &&
    grant.workspacePath === snapshot.workspacePath &&
    grant.workspaceIdentity === snapshot.workspaceIdentity &&
    grant.remoteSessionId === snapshot.remoteSessionId &&
    grant.clientMode === snapshot.clientMode
  );
}

function sameExecutionFence(left: SubagentExecutionFence, right: SubagentExecutionFence): boolean {
  return (
    left.childSessionId === right.childSessionId &&
    left.fencingEpoch === right.fencingEpoch &&
    left.ownerRuntimeId === right.ownerRuntimeId
  );
}

/**
 * ProtocolBrowserControlBroker —— agent 侧 BrowserControlPort 实现。
 *
 * browser-client 的 agent.browsers.* 每个调用经此把一条 BrowserCommand 变成
 * ZCode Protocol 的 interaction/browserExecute 反向请求，由 app（host→main WebContentsView/CDP）
 * 执行并返回结果。与 permission broker 并列注入（server-operations 的 createWorkspaceZCodeApp options）。
 */
export function createProtocolBrowserControlBroker(
  context: ZCodeProtocolAgentServerContext,
): BrowserControlPort {
  const connectionsBySession = new Map<
    string,
    Map<string, { browserId: string; browserGeneration: number }>
  >();
  const subagentDelegation = getSubagentDelegation(context);

  const rememberConnection = (sessionId: string, browserId: string, browserGeneration: number) => {
    const connections = connectionsBySession.get(sessionId) ?? new Map();
    connections.set(`${browserId}\u0000${browserGeneration}`, { browserId, browserGeneration });
    connectionsBySession.set(sessionId, connections);
  };

  const sendLifecycle = async (
    sessionId: string,
    turnId: string | undefined,
    command: { method: "turnEnded"; turnId?: string } | { method: "closeSession" },
  ): Promise<void> => {
    const connections = [...(connectionsBySession.get(sessionId)?.values() ?? [])];
    await Promise.allSettled(
      connections.map(({ browserId, browserGeneration }) =>
        context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...buildBrowserRequestContext(context, { sessionId, turnId }),
            browserId,
            browserGeneration,
            command,
          },
          zcodeBrowserExecuteResultSchema,
        ),
      ),
    );
  };

  /**
   * 带 grant 时：用 grant.parentSessionId 复核父 record，但请求的 sessionId 保持 child。
   * 页面 owner 仍是 child，不能把 child 换成父 ID，也不能把 child 假注册成顶层 session。
   *
   * async 只在 broker 内部：先做同步 grant 匹配，再 await 父 runtime 注入的权威 claim
   * 校验。`authorize` 对外仍是同步 API，bridge 与工具契约不变。
   *
   * await 期间 grant 可能被 revoke 或被同一 child 的新 grant 替换，父 record 的
   * workspace/remote/delivery 也可能变化，因此校验通过后必须再次同步 authorize，
   * 并要求返回的仍是同一个当前 grant；否则两个检查之间会放行已失效的旧 route。
   */
  const resolveSubagentRoute = async (
    sessionId: string,
    delegationGrantId: string | undefined,
    signal?: AbortSignal,
  ): Promise<
    { grant: SubagentBrowserDelegationGrant; parent: ZCodeProtocolSessionRecord } | undefined
  > => {
    if (!delegationGrantId) return undefined;
    const grant = subagentDelegation.authorize({
      grantId: delegationGrantId,
      childSessionId: sessionId,
    });
    if (!grant) throw new Error(SUBAGENT_BROWSER_UNAVAILABLE_MESSAGE);
    // 新执行接管或终态 release 后，旧 grant 可能仍在内存表里；必须在触达 Main 前
    // 用 SessionStore 的 claim 事实复核，不能只信 broker 自己的 fence 水位。
    if (!(await subagentDelegation.validateForRequest(grant))) {
      throw new Error(SUBAGENT_BROWSER_UNAVAILABLE_MESSAGE);
    }
    // 校验是异步的：期间 grant 可能已被 revoke、被同 child 新 grant 替换，父 record 的
    // 快照也可能改变。这里必须再做一次同步授权，且 identity 必须是同一个 grant 对象，
    // 不能只按 grantId 重新取到“某个仍存在的 grant”。
    const currentGrant = subagentDelegation.authorize({
      grantId: delegationGrantId,
      childSessionId: sessionId,
    });
    if (!currentGrant || currentGrant !== grant) {
      throw new Error(SUBAGENT_BROWSER_UNAVAILABLE_MESSAGE);
    }
    // authorize 已确认父 record 存在且快照一致；直接读取避免把 child 当成顶层 session。
    const parent = context.sessions.get(currentGrant.parentSessionId);
    if (!parent) throw new Error(SUBAGENT_BROWSER_UNAVAILABLE_MESSAGE);
    // 等待校验期间用户已取消：不能再真实派发原 command。放在 requestClient 之前，
    // 避免普通 list/execute 在 abort 后仍产生一次后端请求。
    signal?.throwIfAborted();
    return { grant: currentGrant, parent };
  };

  return {
    subagentDelegation,

    async list({ sessionId, turnId, traceContext, signal, delegationGrantId }) {
      const route = await resolveSubagentRoute(sessionId, delegationGrantId, signal);
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionBrowserList,
        buildBrowserRequestContext(context, {
          sessionId,
          turnId,
          traceContext,
          ...(route ? { record: route.parent } : {}),
        }),
        zcodeBrowserListResultSchema,
        buildRequestOptions(traceContext, signal),
      );
      return result.browsers;
    },

    async execute({
      browserId,
      browserGeneration,
      sessionId,
      turnId,
      command,
      traceContext,
      signal,
      delegationGrantId,
    }) {
      const route = await resolveSubagentRoute(sessionId, delegationGrantId, signal);
      if (route && SUBAGENT_DENIED_BROWSER_METHODS.has(command.method)) {
        // 门在 broker：即使模型直接构造越界命令，也不能进入 Main。
        throw new Error(SUBAGENT_BROWSER_UNAVAILABLE_MESSAGE);
      }
      rememberConnection(sessionId, browserId, browserGeneration);
      const requestContext = buildBrowserRequestContext(context, {
        sessionId,
        turnId,
        traceContext,
        ...(route ? { record: route.parent } : {}),
      });
      const cancelBackendRequest = () => {
        // 只取消 agent 侧 requestClient 会让 host/main 的 CDP 动作继续执行。
        // 这里用同一 backend/generation 发送内部 cancelRequest，main 再按原 requestId 中断 waiter；
        // 已下发动作无法证明无副作用时由 manager 返回 uncertain 标记。
        void context
          .requestClient(
            zcodeProtocolMethods.interactionBrowserExecute,
            {
              ...buildBrowserRequestContext(context, {
                sessionId,
                turnId,
                traceContext,
                ...(route ? { record: route.parent } : {}),
              }),
              browserId,
              browserGeneration,
              command: { method: "cancelRequest", requestId: requestContext.requestId },
            },
            zcodeBrowserExecuteResultSchema,
            buildRequestOptions(traceContext, undefined),
          )
          .catch(() => undefined);
      };
      if (signal?.aborted) cancelBackendRequest();
      else signal?.addEventListener("abort", cancelBackendRequest, { once: true });
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...requestContext,
            browserId,
            browserGeneration,
            command,
          },
          zcodeBrowserExecuteResultSchema,
          buildRequestOptions(traceContext, signal),
        );
      } finally {
        signal?.removeEventListener("abort", cancelBackendRequest);
      }
    },

    async turnEnded({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "turnEnded", turnId });
    },

    async closeSession({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "closeSession" });
      connectionsBySession.delete(sessionId);
    },
  };
}

function buildBrowserRequestContext(
  context: ZCodeProtocolAgentServerContext,
  input: {
    sessionId: string;
    turnId?: string;
    traceContext?: TraceContext;
    /** 子代理授权路径传入父 record；sessionId 仍保持 child。 */
    record?: ZCodeProtocolSessionRecord;
  },
) {
  const record = input.record ?? requireSession(context, input.sessionId);
  const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
  const workspacePath = record.workspace.workspacePath;

  return {
    requestId: randomUUID(),
    sessionId: input.sessionId,
    ...((input.turnId ?? input.traceContext?.turnId)
      ? { turnId: String(input.turnId ?? input.traceContext?.turnId) }
      : {}),
    // workspacePath 可能在不同 remote workspace 中相同，隔离 key 必须优先使用
    // workspaceIdentity，避免 browser backend/tab ownership 跨工作区串线。
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    clientMode: record.deliveryKind ?? "desktop-continuous",
    sessionContext: "live" as const,
  };
}

function buildRequestOptions(
  traceContext: TraceContext | undefined,
  signal: AbortSignal | undefined,
): ZCodeProtocolClientRequestOptions {
  return {
    ...(signal ? { signal } : {}),
    ...(traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {}),
  };
}
