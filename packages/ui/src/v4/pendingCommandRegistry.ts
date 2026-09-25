/* eslint-disable max-lines -- pending command 的持久化、迁移和权威对账必须共用一个账本状态机。 */
// V4 已提交命令的 renderer 持久账本。
// 它只保存客户端恢复线索，不参与 conversation projection，也绝不能据此自动重放。
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { isCommandNotSentError } from "@zcode/shared";
import type { PendingCommandClientContext } from "./pendingCommandWorkspace.js";
import { pendingCommandReplayFor, type PendingCommandReplay } from "./pendingCommandReplay.js";
export type { PendingCommandReplay } from "./pendingCommandReplay.js";

const PENDING_COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
const STORAGE_KEY = "zcode-v4-pending-commands:v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingCommandRecovery =
  | {
      kind: "discarded";
      detectedAt: number;
      reasonCode?: string;
    }
  | {
      kind: "unknown";
      detectedAt: number;
      reason: "transport-interrupted" | "query-unknown" | "query-unavailable";
      lastCheckedAt?: number;
    };

export function isConnectionClosedError(error: unknown): boolean {
  return error instanceof Error && error.name === "ConnectionClosed";
}

/**
 * 「确定未上送」优先于「连接已关闭」判定：facade 和 V4 握手都会抛出
 * ConnectionClosed，但断线期在发出之前就拒绝的调用不能记成 unknown。
 */
export function isDefinitelyUnsentCommandError(error: unknown): boolean {
  if (isCommandNotSentError(error)) return true;
  return error instanceof Error && error.message === "ChannelClient is disposed";
}

export interface PendingCommandEntry {
  commandId: string;
  clientId: string;
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number;
  replay: PendingCommandReplay;
  clientContext?: PendingCommandClientContext;
  recovery?: PendingCommandRecovery;
  recoveryDismissed?: boolean;
}

interface PendingCommandReplayRequest {
  type: "sendText" | "sendGoalCommand" | "compact" | "createSession";
  payload: Record<string, unknown>;
  sessionId: string | null;
  baseRevision?: number;
  clientContext?: PendingCommandClientContext;
}

interface PendingCommandRegistryOptions {
  storage?: StorageLike;
  now?: () => number;
}

type QueryCommands = (params: CommandsQueryParams) => Promise<CommandsQueryResult>;

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function keyOf(sessionId: string | null, commandId: string): string {
  return `${sessionId ?? "<global>"}\u0000${commandId}`;
}

function clonePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function isEntry(value: unknown): value is PendingCommandEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PendingCommandEntry>;
  return (
    typeof entry.commandId === "string" &&
    typeof entry.clientId === "string" &&
    (typeof entry.sessionId === "string" || entry.sessionId === null) &&
    typeof entry.issuedAt === "number" &&
    typeof entry.expiresAt === "number" &&
    Boolean(entry.replay) &&
    typeof entry.replay === "object"
  );
}

function normalizeRecovery(
  value: unknown,
  fallbackTimestamp: number,
): PendingCommandRecovery | undefined {
  if (value === "discarded") {
    return { kind: "discarded", detectedAt: fallbackTimestamp };
  }
  if (value === "unknown") {
    return {
      kind: "unknown",
      detectedAt: fallbackTimestamp,
      reason: "query-unknown",
    };
  }
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<PendingCommandRecovery>;
  if (candidate.kind === "discarded" && typeof candidate.detectedAt === "number") {
    return {
      kind: "discarded",
      detectedAt: candidate.detectedAt,
      ...(typeof candidate.reasonCode === "string" ? { reasonCode: candidate.reasonCode } : {}),
    };
  }
  if (
    candidate.kind === "unknown" &&
    typeof candidate.detectedAt === "number" &&
    (candidate.reason === "transport-interrupted" ||
      candidate.reason === "query-unknown" ||
      candidate.reason === "query-unavailable")
  ) {
    return {
      kind: "unknown",
      detectedAt: candidate.detectedAt,
      reason: candidate.reason,
      ...(typeof candidate.lastCheckedAt === "number"
        ? { lastCheckedAt: candidate.lastCheckedAt }
        : {}),
    };
  }
  return undefined;
}

function isRuntimeLocalDiscard(ack: CommandAck): boolean {
  return (
    ack.reasonCode === "fault.command.inputDiscardedOnRestart" &&
    ack.result?.type === "inputDisposition" &&
    (ack.result.delivery === "queue" || ack.result.delivery === "guide")
  );
}

/**
 * ACK、queue 与 transcript 曾分别维护临时状态；renderer 刷新或 ACK 丢失后，
 * UI 已清空但无法证明 CLI 是否 admission。这里把“待对账线索”先于上行持久化，并用
 * queue/guided/transcript sourceCommandId 或显式终态收口；registry 本身永远不产生权威事实。
 */
export class PendingCommandRegistry {
  private readonly storage: StorageLike | undefined;
  private readonly now: () => number;
  private readonly entries = new Map<string, PendingCommandEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly reconcileInFlight = new Map<string, Promise<void>>();

  constructor(options: PendingCommandRegistryOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.now = options.now ?? Date.now;
    this.load();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(
    envelope: CommandEnvelope,
    clientContext?: PendingCommandClientContext,
  ): PendingCommandEntry {
    this.pruneExpired();
    const replay = pendingCommandReplayFor(envelope);
    const key = keyOf(envelope.sessionId, envelope.commandId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: PendingCommandEntry = {
      commandId: envelope.commandId,
      clientId: envelope.clientId,
      sessionId: envelope.sessionId,
      issuedAt: envelope.issuedAt,
      // TTL 锚定首次登记时间；reload/reconcile 不得续期。
      expiresAt: this.now() + PENDING_COMMAND_TTL_MS,
      replay,
      ...(clientContext ? { clientContext } : {}),
    };
    this.entries.set(key, entry);
    this.commit();
    return entry;
  }

  list(sessionId: string | null): readonly PendingCommandEntry[] {
    const now = this.now();
    return [...this.entries.values()]
      .filter((entry) => entry.expiresAt > now && entry.sessionId === sessionId)
      .sort((left, right) => left.issuedAt - right.issuedAt);
  }

  listRecoverable(sessionId: string | null): readonly PendingCommandEntry[] {
    return this.list(sessionId).filter(
      (entry) => Boolean(entry.recovery) && !entry.recoveryDismissed,
    );
  }

  has(sessionId: string | null, commandId: string): boolean {
    return this.entries.has(keyOf(sessionId, commandId));
  }

  settle(sessionId: string | null, commandId: string): void {
    if (!this.entries.delete(keyOf(sessionId, commandId))) return;
    this.commit();
  }

  dismissRecovery(sessionId: string | null, commandId: string): void {
    const key = keyOf(sessionId, commandId);
    const entry = this.entries.get(key);
    if (!entry?.recovery || entry.recoveryDismissed) return;
    this.entries.set(key, { ...entry, recoveryDismissed: true });
    this.commit();
  }

  markTransportInterrupted(sessionId: string | null, commandId: string): void {
    const entry = this.entries.get(keyOf(sessionId, commandId));
    if (!entry || entry.recovery?.kind === "discarded") return;
    this.markRecovery(entry, {
      kind: "unknown",
      detectedAt: entry.recovery?.detectedAt ?? this.now(),
      reason: "transport-interrupted",
      lastCheckedAt: this.now(),
    });
  }

  applyAck(envelope: CommandEnvelope, ack: CommandAck): void {
    let entry = this.entries.get(keyOf(envelope.sessionId, envelope.commandId));
    if (!entry) return;
    if (entry.replay.kind === "sensitiveDigest") {
      // 交互答案不可重放；拿到确定 ACK 后其对账职责已结束。
      this.settle(entry.sessionId, entry.commandId);
      return;
    }
    entry = this.remapCreatedSession(entry, ack);
    if (ack.status === "accepted" || ack.status === "duplicate") {
      if (entry.replay.kind === "nonReplayable") {
        this.settle(entry.sessionId, entry.commandId);
      } else {
        this.clearRecovery(entry);
      }
      return;
    }
    if (ack.status === "failed" && ack.reasonCode === "fault.command.inputDiscardedOnRestart") {
      if (isRuntimeLocalDiscard(ack)) {
        this.settle(entry.sessionId, entry.commandId);
        return;
      }
      this.markRecovery(entry, {
        kind: "discarded",
        detectedAt: this.now(),
        ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
      });
      return;
    }
    this.settle(entry.sessionId, entry.commandId);
  }

  applyQuery(result: CommandsQueryResult): void {
    for (const item of result.results) {
      let entry = this.entries.get(keyOf(item.key.sessionId, item.key.commandId));
      if (!entry) continue;
      if (item.result === "unknown") {
        if (entry.recovery?.kind === "discarded") continue;
        this.markRecovery(entry, {
          kind: "unknown",
          detectedAt: entry.recovery?.detectedAt ?? this.now(),
          reason: "query-unknown",
          lastCheckedAt: this.now(),
        });
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.queryUnavailable"
      ) {
        if (entry.recovery?.kind === "discarded") continue;
        this.markRecovery(entry, {
          kind: "unknown",
          detectedAt: entry.recovery?.detectedAt ?? this.now(),
          reason: "query-unavailable",
          lastCheckedAt: this.now(),
        });
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.inputDiscardedOnRestart"
      ) {
        if (isRuntimeLocalDiscard(item.result)) {
          this.settle(entry.sessionId, entry.commandId);
          continue;
        }
        this.markRecovery(entry, {
          kind: "discarded",
          detectedAt: this.now(),
          ...(item.result.reasonCode ? { reasonCode: item.result.reasonCode } : {}),
        });
        continue;
      }
      entry = this.remapCreatedSession(entry, item.result);
      if (entry.replay.kind === "sensitiveDigest") {
        this.settle(entry.sessionId, entry.commandId);
        continue;
      }
      if (item.result.status === "accepted" || item.result.status === "duplicate") {
        if (entry.replay.kind === "nonReplayable") {
          this.settle(entry.sessionId, entry.commandId);
        } else {
          this.clearRecovery(entry);
        }
      } else {
        this.settle(entry.sessionId, entry.commandId);
      }
    }
  }

  reconcileSnapshot(snapshot: ConversationSnapshot): void {
    const settled = new Set<string>();
    for (const item of snapshot.queue.items) {
      if (item.sourceCommandId) {
        // 把“进入 queue”当成仍未投递的话，直到 transcript 才清理
        // localStorage；App/CLI 重启后旧 runtime queue 被正常丢弃，却又触发重发提示。
        // queue projection 已是 CLI 权威接收证据，renderer ingress 账本应在此结算。
        settled.add(item.sourceCommandId);
      }
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        settled.add(row.sourceCommandId);
      }
      if (row.kind === "timelineMarker" && row.marker.type === "compact" && row.sourceCommandId) {
        // compact 不产生 user row；timeline marker 是该维护命令已开始执行的权威证据。
        settled.add(row.sourceCommandId);
      }
    }
    if (settled.size === 0) return;
    let changed = false;
    for (const commandId of settled) {
      changed = this.entries.delete(keyOf(snapshot.sessionId, commandId)) || changed;
    }
    if (changed) this.commit();
  }

  reconcileSession(sessionId: string | null, query: QueryCommands): Promise<void> {
    const inFlightKey = sessionId ?? "<global>";
    const existing = this.reconcileInFlight.get(inFlightKey);
    if (existing) return existing;
    const pending = this.runReconcile(sessionId, query).finally(() => {
      if (this.reconcileInFlight.get(inFlightKey) === pending) {
        this.reconcileInFlight.delete(inFlightKey);
      }
    });
    this.reconcileInFlight.set(inFlightKey, pending);
    return pending;
  }

  consumeReplay(key: {
    sessionId: string | null;
    commandId: string;
  }): PendingCommandReplayRequest | null {
    const entry = this.entries.get(keyOf(key.sessionId, key.commandId));
    if (!entry || entry.replay.kind !== "input" || entry.recovery?.kind !== "discarded") {
      return null;
    }
    const request: PendingCommandReplayRequest = {
      type: entry.replay.type,
      payload: clonePayload(entry.replay.payload),
      sessionId: entry.sessionId,
      ...(entry.replay.baseRevision !== undefined
        ? { baseRevision: entry.replay.baseRevision }
        : {}),
      ...(entry.clientContext ? { clientContext: entry.clientContext } : {}),
    };
    // 用户已确认以新 commandId 重发，旧 discarded 线索在本地完成收口。
    this.settle(entry.sessionId, entry.commandId);
    return request;
  }

  private async runReconcile(sessionId: string | null, query: QueryCommands): Promise<void> {
    const entries = this.list(sessionId);
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      const result = await query({
        commands: batch.map((entry) => ({
          sessionId: entry.sessionId,
          commandId: entry.commandId,
        })),
      });
      this.applyQuery(result);
    }
  }

  private markRecovery(entry: PendingCommandEntry, recovery: PendingCommandRecovery): void {
    if (
      entry.recovery?.kind === recovery.kind &&
      JSON.stringify(entry.recovery) === JSON.stringify(recovery)
    ) {
      return;
    }
    this.entries.set(keyOf(entry.sessionId, entry.commandId), {
      ...entry,
      recovery,
      recoveryDismissed: entry.recovery?.kind === recovery.kind ? entry.recoveryDismissed : false,
    });
    this.commit();
  }

  private clearRecovery(entry: PendingCommandEntry): void {
    if (!entry.recovery && !entry.recoveryDismissed) return;
    const { recovery: _recovery, recoveryDismissed: _dismissed, ...settled } = entry;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), settled);
    this.commit();
  }

  private remapCreatedSession(entry: PendingCommandEntry, ack: CommandAck): PendingCommandEntry {
    if (
      entry.replay.kind !== "input" ||
      entry.replay.type !== "createSession" ||
      (ack.status !== "accepted" && ack.status !== "duplicate") ||
      ack.result?.type !== "createSession" ||
      entry.sessionId === ack.result.sessionId
    ) {
      return entry;
    }
    this.entries.delete(keyOf(entry.sessionId, entry.commandId));
    const remapped = { ...entry, sessionId: ack.result.sessionId };
    this.entries.set(keyOf(remapped.sessionId, remapped.commandId), remapped);
    this.commit();
    return remapped;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (isEntry(value)) {
          const { recovery: _legacyRecovery, ...entryWithoutRecovery } = value;
          // 持久化内容是历史格式：recovery 可能是 V4 初版的 legacy 字符串。
          const rawRecovery = (value as { recovery?: unknown }).recovery;
          const recovery = normalizeRecovery(rawRecovery, value.issuedAt);
          // legacy `unknown` 从来不是可操作事实，也从未进入过 UI；升级后只保留账本线索，
          // 默认按 dismissed 处理，避免凭空冒出一批结果未知提示。
          this.entries.set(
            keyOf(value.sessionId, value.commandId),
            recovery
              ? {
                  ...entryWithoutRecovery,
                  recovery,
                  ...(rawRecovery === "unknown" ? { recoveryDismissed: true } : {}),
                }
              : entryWithoutRecovery,
          );
        }
      }
      this.pruneExpired();
    } catch {
      // storage 损坏不能阻断聊天；丢弃的是客户端恢复线索，不影响 CLI 权威事实。
      this.entries.clear();
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  private commit(): void {
    if (this.storage) {
      try {
        if (this.entries.size === 0) {
          this.storage.removeItem(STORAGE_KEY);
        } else {
          this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
        }
      } catch {
        // quota/incognito：退化为当前 renderer 内存账本。
      }
    }
    for (const listener of this.listeners) listener();
  }
}

export const pendingCommandRegistry = new PendingCommandRegistry();
