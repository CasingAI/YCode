// 原生 handler 注册表（每组加一行 spread）。
// 组文件命名 = 命令分组：session-flow / queue / session-mgmt /
// goal-compact / model-config / interaction-background / fork-edit-retry。
import { agentWorktreeHandlers } from "./agent-worktree.js";
import { aiHistorySearchHandlers } from "./ai-history-search.js";
import { forkEditRetryHandlers } from "./fork-edit-retry.js";
import { fileRewindHandlers } from "./file-rewind.js";
import { goalCompactHandlers } from "./goal-compact.js";
import { interactionBackgroundHandlers } from "./interaction-background.js";
import { modelConfigHandlers } from "./model-config.js";
import { queueHandlers } from "./queue.js";
import { sessionFlowHandlers } from "./session-flow.js";
import { sessionMgmtHandlers } from "./session-mgmt.js";
import { selectionSideSessionHandlers } from "./selection-side-session.js";
import { assistantFeedbackHandlers } from "./assistant-feedback.js";

import { resumeSuspendedHandlers } from "./resume-suspended.js";

export const NATIVE_HANDLERS = {
  ...sessionFlowHandlers,
  ...queueHandlers,
  ...sessionMgmtHandlers,
  ...agentWorktreeHandlers,
  ...aiHistorySearchHandlers,
  ...selectionSideSessionHandlers,
  ...goalCompactHandlers,
  ...modelConfigHandlers,
  ...interactionBackgroundHandlers,
  ...forkEditRetryHandlers,
  ...resumeSuspendedHandlers,
  ...fileRewindHandlers,
  ...assistantFeedbackHandlers,
} as const;
