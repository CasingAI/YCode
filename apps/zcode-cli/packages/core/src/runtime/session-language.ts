import { SESSION_ENTRY_SESSION_LANGUAGE, type SessionId, type SessionEntryInfo } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";

/**
 * 会话语言：创建时快照的界面语言（解析后的实际语言，如 `zh-CN`）。
 *
 * 它是会话级事实，一旦写入不再变化，因此**没有对应的会话事件**——只经 session entry
 * 持久化，冷恢复据此还原；投影侧由 `SessionConfigSeed` 从 runtime 真值注入。
 *
 * 真值位置与 mode 一致：`runtime.config.language`。
 */
export function readRuntimeSessionLanguage(runtime: AgentRuntimeInternal): string | undefined {
  return runtime.config.language;
}

export function buildSessionLanguageEntry(
  sessionId: SessionId,
  language: string,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${sessionId}:runtime-session-language`,
    sessionID: sessionId,
    type: SESSION_ENTRY_SESSION_LANGUAGE,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: { language },
  };
}

/**
 * 落盘会话语言。
 *
 * 只在会话已进入持久化 store 后写：draft 期 `session_entry` 还没有可挂靠的 session 行，
 * 这里静默跳过，由 `ensureSessionPersisted` 在会话行创建后补写——与 execution_state 同一
 * 处理方式（见 `runtime/methods/events.ts`）。
 */
export async function persistRuntimeSessionLanguage(
  runtime: AgentRuntimeInternal,
  language = readRuntimeSessionLanguage(runtime),
): Promise<void> {
  if (!language) return;
  if (!runtime.sessionPersisted || !runtime.sessionStore?.saveSessionEntry) return;
  await runtime.sessionStore.saveSessionEntry(
    buildSessionLanguageEntry(runtime.sessionId, language),
  );
}

/** 从 session entry 解析语言；升级前无该 entry、或数据形态不符时返回 undefined（未知）。 */
export function parseSessionLanguageEntry(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>).language;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
