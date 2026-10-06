import type { SessionCreateSource } from "@zcode/shared";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";

export interface PendingCommandClientContext {
  workspace?: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  groupedDraftTask?: GroupedDraftTaskState;
  sessionCreateSource?: SessionCreateSource;
}
