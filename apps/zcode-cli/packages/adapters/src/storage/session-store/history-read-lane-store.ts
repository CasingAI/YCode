import type { DatabaseSync } from "node:sqlite";
import type { HistoryStoreReads, ListSessionsInput, SessionId } from "@zcode/contracts";
import * as messageRepository from "./repositories/messages.js";
import * as sessionRepository from "./repositories/sessions.js";

/** 只读旁路工作线程里的 SessionStore 读子集，不跑迁移、不碰写路径。 */
export function createHistoryReadStore(db: DatabaseSync): HistoryStoreReads {
  return {
    listSessions: async (input?: ListSessionsInput) =>
      sessionRepository.listSessions(db, input ?? {}),
    getSession: async (sessionID: SessionId) => sessionRepository.getSession(db, sessionID),
    messages: async (input) => messageRepository.messages(db, input),
    sessionMessageCounts: async (input) => messageRepository.sessionMessageCounts(db, input),
  };
}
