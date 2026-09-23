import {
  readSessionPlanFileWrittenFacts,
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
