import {
  listSessionPlanEntries as readSessionPlanEntries,
  readSessionPlanFileWrittenFacts,
  type SessionPlanEntry,
  type SessionPlanFileWrittenFact,
} from "../helpers/plan-file-continuity.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 本会话的计划落盘事实（哪个工具调用落了哪份计划、落在哪），读的是运行时自有的计划目录。
 *
 * 这是给冷恢复用的持久读口：`plan_file_written` 事件只在进程内存活，重启后 bootstrap 只能靠
 * 目录重推导同一份事实，而目录位置（workspaceRoot + 会话计划子目录）是运行时自己的知识——
 * bootstrap 的协议层不碰文件系统，所以由运行时读完再交出去。
 *
 * 没有文件系统通道（沙箱、测试、无 FS 的嵌入场景）时返回空：这不是错误，只是这次冷恢复没有
 * 这条来源，调用方少一个展示字段而已。目录不存在同样是空（listSessionPlanFiles 已按 not_found 兜底）；
 * 其余读取错误上抛，由调用方决定记日志还是中断。
 */
export async function listSessionPlanFileWrittenFacts(
  this: AgentRuntimeInternal,
): Promise<SessionPlanFileWrittenFact[]> {
  if (!this.fileSystemPort) return [];
  return readSessionPlanFileWrittenFacts({
    fileSystemPort: this.fileSystemPort,
    sessionId: this.sessionId,
    workspaceRoot: this.workspaceRoot,
  });
}

/**
 * 会话计划目录条目（一条文件一条，按创建时间降序），供用户侧计划目录查询使用。
 *
 * 目录读的就是 `ListPlans` 读的那批文件，所以两个视图的条数永远一致——与 transcript 里
 * `ExitPlanMode` 被调用过几次无关（未落盘的失败调用不产生文件，也就不进目录）。
 * 读目录是运行时的知识（workspaceRoot 与会话计划子目录的位置），协议层不碰文件系统。
 *
 * 没有文件系统通道（沙箱、测试、无 FS 的嵌入场景）时返回空：这不是错误，只是这次没有
 * 计划可列。其余读取错误上抛，由调用方决定记日志还是中断。
 */
export async function listSessionPlanEntries(
  this: AgentRuntimeInternal,
): Promise<SessionPlanEntry[]> {
  if (!this.fileSystemPort) return [];
  return readSessionPlanEntries({
    fileSystemPort: this.fileSystemPort,
    sessionId: this.sessionId,
    workspaceRoot: this.workspaceRoot,
  });
}
