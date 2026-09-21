// ============================================================
// Context Tools - runtime backing for CompactNow / GetContextUsage
// ============================================================
// 状态所有者是 runtime（pendingToolCompactRequest）；工具 handler 只通过
// SessionContextControlPort 调到这里。事件顺序与安全闸约束见
// docs/specs/session-context-tools.md。

import {
  DEFAULT_COMPACT_CONTEXT_WINDOW,
  buildSessionContextUsageSummary,
  type Model,
} from "../deps.js";
import type { SessionContextUsageSnapshot } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { estimateRuntimeEntryTokens } from "../helpers/compact-selection.js";
import { createTurnModel } from "./turn-model.js";
import { estimateAutoCompactContextUsage } from "./compact.js";

export function requestCompactNowFromTool(this: AgentRuntimeInternal): void {
  this.pendingToolCompactRequest = true;
}

/** 读即清：一次请求至多触发一次压缩，防止残留在无 turn 的会话里反复生效。 */
export function consumePendingToolCompactRequest(this: AgentRuntimeInternal): boolean {
  const pending = this.pendingToolCompactRequest;
  this.pendingToolCompactRequest = false;
  return pending;
}

export function getContextUsageSnapshotForTool(
  this: AgentRuntimeInternal,
): SessionContextUsageSnapshot {
  const entries = this.messageHistory.borrowReadOnlyRuntimeEntries();
  // 模型缺席（未配置/失效）时退回默认窗口 + 本地估算，让工具仍能给出可用的量级，
  // 但口径降级要体现在 tokenSource 上。
  let model: Model | undefined;
  try {
    model = createTurnModel(this);
  } catch {
    model = undefined;
  }

  if (model) {
    const usage = estimateAutoCompactContextUsage.call(this, model);
    return {
      ...buildSessionContextUsageSummary({ config: usage.config, tokenCount: usage.tokenCount }),
      tokenSource: usage.tokenSource,
    };
  }
  return {
    ...buildSessionContextUsageSummary({
      config: { contextWindow: DEFAULT_COMPACT_CONTEXT_WINDOW },
      tokenCount: estimateRuntimeEntryTokens(entries),
    }),
    tokenSource: "estimate",
  };
}
