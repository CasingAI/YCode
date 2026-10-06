// Agent worktree 隔离命令组（docs/specs/agent-worktree-isolation.md）：
// attachAgentWorktree 对已有草稿会话补挂隔离；createSession.config.agentWorktree
// 复用同一 attach 流程（见 session-mgmt.ts）。
// 决策只读 CLI 侧 record/runtime 状态：persistence=deferred 才可挂；提升后执行根冻结。
// git 进程调用收口在 @zcode/adapters 建树助手，本文件只做准入裁决与稳定码翻译。
import {
  AGENT_WORKTREE_ATTACH_REJECTED_FAULT_PREFIX,
  type AgentWorktreeAttachRejectedReason,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  AgentWorktreeError,
  agentWorktreePathFor,
  createAgentWorktree,
  isValidGitBranchName,
} from "@zcode/adapters/git";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";

export type AgentWorktreeInfo = { branch: string; path: string };

/** attach 拒绝：reasonCode = fault.command.agentWorktreeAttachRejected.<reason>，UI 按 i18n 反查。 */
export class V4AgentWorktreeRejectedError extends Error {
  readonly reasonCode: string;

  constructor(readonly reason: AgentWorktreeAttachRejectedReason) {
    super(`v4 agent worktree attach rejected: ${reason}`);
    this.name = "V4AgentWorktreeRejectedError";
    this.reasonCode = AGENT_WORKTREE_ATTACH_REJECTED_FAULT_PREFIX + reason;
  }
}

/**
 * 对草稿会话建树并迁移执行根。createSession.config 与 attachAgentWorktree 共用：
 * - persistence != deferred → session_promoted（提升后执行根冻结，不拆不改）。
 * - 已挂同分支 → noop（幂等重放）；已挂其它分支 → session_bound。
 * - 建树失败翻译稳定码上抛；用户仓库状态由助手保证不被污染。
 */
export async function attachAgentWorktreeToDraft(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  sessionId: string,
  branch: string,
): Promise<AgentWorktreeInfo> {
  if (record.persistence !== "deferred") {
    throw new V4AgentWorktreeRejectedError("session_promoted");
  }
  const existing = record.app.runtime.getAgentWorktree();
  if (existing) {
    if (existing.branch === branch) {
      throw new V4CommandNoopError(
        "guard.agentWorktreeBranchAlreadyAttached",
        `agent worktree already attached with branch ${branch}`,
      );
    }
    throw new V4AgentWorktreeRejectedError("session_bound");
  }
  if (!isValidGitBranchName(branch)) {
    throw new V4AgentWorktreeRejectedError("invalid_branch_name");
  }
  const repoRoot = record.workspace.workspacePath;
  const worktreePath = agentWorktreePathFor(repoRoot, sessionId);
  try {
    await createAgentWorktree({ branch, repoRoot, worktreePath });
  } catch (error) {
    if (error instanceof AgentWorktreeError) {
      host.logger?.warn?.("v4 agent worktree create failed", {
        event: "v4.agent_worktree.create_failed",
        reason: error.reason,
        sessionId,
        workspacePath: repoRoot,
      });
      throw new V4AgentWorktreeRejectedError(error.reason);
    }
    throw error;
  }
  // 执行根迁移同时改 workingDirectory/workspaceRoot 并发 SessionWorktreeChanged
  //（投影经事件 ingest 自动更新）；身份 ref（record.workspace）保持原工作区。
  await record.app.runtime.relocateExecutionRoot(worktreePath, { branch, path: worktreePath });
  host.logger?.info?.("v4 agent worktree attached", {
    event: "v4.agent_worktree.attached",
    branch,
    sessionId,
    worktreePath,
    workspacePath: repoRoot,
  });
  return { branch, path: worktreePath };
}

async function attachAgentWorktree(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["attachAgentWorktree"];
  const record = requireRecord(host, envelope.sessionId);
  await attachAgentWorktreeToDraft(host, record, envelope.sessionId as string, payload.branch);
  return undefined;
}

export const agentWorktreeHandlers = {
  attachAgentWorktree,
};
