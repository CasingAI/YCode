import type {
  CreateSessionInput,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  SessionEntryInfo,
  SessionEvent,
  SessionEventStorePort,
  SessionId,
  SessionInfo,
  SessionStorePort,
  SubagentExecutionClaim,
  SubagentExecutionClaimRequest,
  SubagentExecutionClaimResult,
  SubagentFirstExecutionInit,
  SubagentFirstExecutionInitResult,
  SubagentIdentityBinding,
  SubagentIdentityResolution,
} from "@zcode/contracts";

/**
 * 子智能体模型固定绑定夹具的持久化介质替身：只替换存储实现，身份解析、
 * execution claim 租约、entry 读写与事件追加的语义都与生产端口保持一致，
 * 未实现的可选能力保持 undefined，让 runtime 走各自的缺席分支。
 */
export class InMemoryPinningSessionStore {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly messagesBySession = new Map<string, Map<string, MessageWithParts>>();
  private readonly partsByMessage = new Map<string, Map<string, MessagePart>>();
  private readonly entriesBySession = new Map<string, SessionEntryInfo[]>();
  private readonly identities = new Map<string, SubagentIdentityBinding>();
  private readonly claims = new Map<string, SubagentExecutionClaim>();
  private claimEpoch = 0;
  private messageOrder = 0;

  /** 返回 true 时该 entry 的写入被拒绝，用于验证持久化失败拒绝启动。 */
  failEntryWrite?: (entry: SessionEntryInfo) => boolean;
  /** 返回 true 时该 entry 的读取被拒绝，用于验证读取失败拒绝启动。 */
  failEntryRead?: (input: { sessionID: SessionId; type?: string }) => boolean;

  readonly port: SessionStorePort;

  constructor() {
    this.port = new Proxy(this, {
      get(object, property, receiver) {
        if (typeof property === "symbol") return Reflect.get(object, property, receiver);
        // 未实现的可选端口方法必须表现为 undefined（而不是 thenable/伪函数），
        // 否则 runtime 的 `store.x?.()` 能力门会被伪造出“已实现但返回 undefined”。
        return Reflect.get(object, property, receiver);
      },
    }) as unknown as SessionStorePort;
  }

  entriesFor(sessionId: SessionId | string, type?: string): SessionEntryInfo[] {
    const entries = this.entriesBySession.get(String(sessionId)) ?? [];
    return type ? entries.filter((entry) => entry.type === type) : [...entries];
  }

  /** 模拟旧 child（升级前只有具体选择）或迁移/删除 entry 的历史数据。 */
  deleteEntries(sessionId: SessionId | string, type: string): void {
    const sessionIdKey = String(sessionId);
    const entries = this.entriesBySession.get(sessionIdKey);
    if (!entries) return;
    this.entriesBySession.set(
      sessionIdKey,
      entries.filter((entry) => entry.type !== type),
    );
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const now = Date.now();
    const session: SessionInfo = {
      id: input.id,
      projectID: input.projectID,
      ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
      ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
      ...(input.traceID === undefined ? {} : { traceID: input.traceID }),
      taskType: input.taskType ?? "interactive",
      slug: input.slug,
      directory: input.directory,
      ...(input.path === undefined ? {} : { path: input.path }),
      title: input.title,
      ...(input.titleSource === undefined ? {} : { titleSource: input.titleSource }),
      ...(input.titleMessageID === undefined ? {} : { titleMessageID: input.titleMessageID }),
      version: input.version,
      ...(input.permission === undefined ? {} : { permission: input.permission }),
      time: {
        created: input.time?.created ?? now,
        updated: input.time?.updated ?? now,
      },
    };
    this.sessions.set(String(session.id), session);
    return session;
  }

  async createSubagentChildSession(
    input: CreateSessionInput,
    identity: SubagentIdentityBinding,
  ): Promise<SessionInfo> {
    if (input.taskType !== "subagent_child") {
      throw new Error("createSubagentChildSession requires taskType=subagent_child");
    }
    const existing = this.identities.get(identity.agentId);
    if (existing) {
      if (existing.childSessionId !== identity.childSessionId) {
        throw new Error("agentId already bound to another child session");
      }
      const bound = this.sessions.get(existing.childSessionId);
      if (bound) return bound;
    }
    const session = await this.createSession(input);
    this.identities.set(identity.agentId, { ...identity });
    return session;
  }

  async initializeSubagentFirstExecution(
    init: SubagentFirstExecutionInit,
  ): Promise<SubagentFirstExecutionInitResult> {
    const existingBinding = this.identities.get(init.identity.agentId);
    if (existingBinding && existingBinding.childSessionId !== init.identity.childSessionId) {
      throw new Error("Subagent first execution conflicts with existing identity");
    }
    let child = this.sessions.get(String(init.input.id));
    if (!child) child = await this.createSession(init.input);
    if (init.input.taskType !== "subagent_child") {
      throw new Error("initializeSubagentFirstExecution requires taskType=subagent_child");
    }
    this.identities.set(init.identity.agentId, { ...init.identity });
    const claim = this.issueClaim(
      init.identity.childSessionId,
      init.ownerRuntimeId,
      init.now,
      init.leaseMs,
    );
    return { child, claim };
  }

  async resolveSubagentIdentity(agentId: string): Promise<SubagentIdentityResolution | null> {
    const binding = this.identities.get(agentId);
    if (!binding) return null;
    const child = this.sessions.get(binding.childSessionId);
    if (!child || child.taskType !== "subagent_child") return null;
    return { binding, child };
  }

  async acquireSubagentExecutionClaim(
    input: SubagentExecutionClaimRequest,
  ): Promise<SubagentExecutionClaimResult> {
    const existing = this.claims.get(input.childSessionId);
    if (
      existing &&
      existing.expiresAt > input.now &&
      existing.ownerRuntimeId !== input.ownerRuntimeId
    ) {
      return { acquired: false };
    }
    if (input.expectedEpoch !== undefined && existing?.fencingEpoch !== input.expectedEpoch) {
      return { acquired: false };
    }
    const claim = this.issueClaim(
      input.childSessionId,
      input.ownerRuntimeId,
      input.now,
      input.leaseMs,
    );
    return { acquired: true, claim };
  }

  async renewSubagentExecutionClaim(claim: SubagentExecutionClaim): Promise<boolean> {
    const existing = this.claims.get(claim.childSessionId);
    if (
      !existing ||
      existing.ownerRuntimeId !== claim.ownerRuntimeId ||
      existing.fencingEpoch !== claim.fencingEpoch
    ) {
      return false;
    }
    existing.expiresAt = claim.expiresAt;
    return true;
  }

  async releaseSubagentExecutionClaim(fence: {
    childSessionId: string;
    ownerRuntimeId: string;
    fencingEpoch: number;
  }): Promise<boolean> {
    const existing = this.claims.get(fence.childSessionId);
    if (
      !existing ||
      existing.ownerRuntimeId !== fence.ownerRuntimeId ||
      existing.fencingEpoch !== fence.fencingEpoch
    ) {
      return false;
    }
    this.claims.delete(fence.childSessionId);
    return true;
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return this.sessions.get(String(sessionID)) ?? null;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()];
  }

  async updateSession(input: {
    id: SessionId;
    title?: string;
    [key: string]: unknown;
  }): Promise<SessionInfo> {
    const session = this.sessions.get(String(input.id));
    if (!session) throw new Error(`Session not found: ${String(input.id)}`);
    if (typeof input.title === "string") session.title = input.title;
    session.time = { ...session.time, updated: Date.now() };
    return session;
  }

  async saveMessage(input: MessageInfo): Promise<void> {
    const sessionId = String(input.sessionID);
    let messages = this.messagesBySession.get(sessionId);
    if (!messages) {
      messages = new Map();
      this.messagesBySession.set(sessionId, messages);
    }
    const existing = messages.get(String(input.id));
    if (!existing) {
      this.messageOrder += 1;
      messages.set(String(input.id), {
        info: input,
        parts: [],
        __order: this.messageOrder,
      } as unknown as MessageWithParts & { __order: number });
      return;
    }
    existing.info = input;
  }

  async savePart(input: MessagePart): Promise<void> {
    const sessionId = String(input.sessionID);
    const messageId = String(input.messageID);
    let parts = this.partsByMessage.get(`${sessionId}:${messageId}`);
    if (!parts) {
      parts = new Map();
      this.partsByMessage.set(`${sessionId}:${messageId}`, parts);
    }
    parts.set(String(input.id), input);
    const message = this.messagesBySession.get(sessionId)?.get(messageId);
    if (message) {
      message.parts = [...parts.values()];
    }
  }

  async removeMessage(input: { sessionID: SessionId; messageID: string }): Promise<void> {
    const sessionId = String(input.sessionID);
    this.messagesBySession.get(sessionId)?.delete(String(input.messageID));
    this.partsByMessage.delete(`${sessionId}:${String(input.messageID)}`);
  }

  async removePart(input: {
    sessionID: SessionId;
    messageID: string;
    partID: string;
  }): Promise<void> {
    const sessionId = String(input.sessionID);
    const key = `${sessionId}:${String(input.messageID)}`;
    this.partsByMessage.get(key)?.delete(String(input.partID));
    const message = this.messagesBySession.get(sessionId)?.get(String(input.messageID));
    if (message) message.parts = [...(this.partsByMessage.get(key)?.values() ?? [])];
  }

  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: string;
  }): Promise<MessageWithParts | null> {
    return (
      this.messagesBySession.get(String(input.sessionID))?.get(String(input.messageID)) ?? null
    );
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    const messages = [...(this.messagesBySession.get(String(input.sessionID))?.values() ?? [])];
    return messages.sort((left, right) => {
      const leftOrder = (left as unknown as { __order?: number }).__order ?? 0;
      const rightOrder = (right as unknown as { __order?: number }).__order ?? 0;
      return leftOrder - rightOrder;
    });
  }

  async sessionMessageCounts(input: { sessionIDs: SessionId[] }): Promise<Record<string, number>> {
    return Object.fromEntries(
      input.sessionIDs.map((sessionId) => [
        String(sessionId),
        this.messagesBySession.get(String(sessionId))?.size ?? 0,
      ]),
    );
  }

  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    if (this.failEntryWrite?.(input)) {
      throw new Error(`Injected session entry write failure: ${input.type}`);
    }
    const sessionId = String(input.sessionID);
    let entries = this.entriesBySession.get(sessionId);
    if (!entries) {
      entries = [];
      this.entriesBySession.set(sessionId, entries);
    }
    const existingIndex = entries.findIndex((entry) => entry.id === input.id);
    if (existingIndex >= 0) entries[existingIndex] = input;
    else entries.push(input);
  }

  async sessionEntries(input: {
    sessionID: SessionId;
    type?: string;
  }): Promise<SessionEntryInfo[]> {
    if (this.failEntryRead?.(input)) {
      throw new Error(`Injected session entry read failure: ${input.type ?? "*"}`);
    }
    return this.entriesFor(input.sessionID, input.type);
  }

  async readTodos(): Promise<never[]> {
    return [];
  }

  async updateTodos(): Promise<void> {}

  async readTarget(): Promise<null> {
    return null;
  }

  async setTarget(): Promise<never> {
    throw new Error("setTarget is not used in pinning tests");
  }

  private issueClaim(
    childSessionId: string,
    ownerRuntimeId: string,
    now: number,
    leaseMs: number,
  ): SubagentExecutionClaim {
    this.claimEpoch += 1;
    const claim: SubagentExecutionClaim = {
      childSessionId,
      ownerRuntimeId,
      fencingEpoch: this.claimEpoch,
      expiresAt: now + leaseMs,
    };
    this.claims.set(childSessionId, claim);
    return claim;
  }
}

/** 只保留生产 append 语义的最小 EventStore：按 session 追加并补 sequenceNumber。 */
export class TestSessionEventStore {
  private readonly bySession = new Map<string, SessionEvent[]>();

  readonly port: SessionEventStorePort = {
    append: async (event) => {
      const sessionId = String(event.sessionId);
      let events = this.bySession.get(sessionId);
      if (!events) {
        events = [];
        this.bySession.set(sessionId, events);
      }
      const stored: SessionEvent = { ...event, sequenceNumber: events.length + 1 };
      events.push(stored);
      return stored;
    },
    getEvents: async (sessionId) => this.snapshot(sessionId),
    getEventsAfter: async (sessionId, sequenceNumber) =>
      this.snapshot(sessionId).filter((event) => event.sequenceNumber > sequenceNumber),
    getLatestSequenceNumber: async (sessionId) =>
      this.bySession.get(String(sessionId))?.length ?? 0,
    deleteSession: async (sessionId) => {
      this.bySession.delete(String(sessionId));
    },
  };

  snapshot(sessionId: SessionId | string): SessionEvent[] {
    return [...(this.bySession.get(String(sessionId)) ?? [])];
  }

  eventTypes(sessionId: SessionId | string): string[] {
    return this.snapshot(sessionId).map((event) => String(event.type));
  }
}
