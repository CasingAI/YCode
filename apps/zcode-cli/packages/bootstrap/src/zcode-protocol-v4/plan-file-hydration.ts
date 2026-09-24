// 冷恢复的计划落盘事实：把运行时读出的计划目录事实映射成 `plan_file_written` 事件。
//
// 为什么要第二个来源：live 事件在进程重启后消失，而 transcript 不记录落盘路径——v4 UI 会
// 静默拒绝计划批准，拒绝路径连工具输出都没有。只看这两源，重启后打开的历史计划卡片就没有
// 文件名、详情面板也没有路径行。计划目录是运行时自有的持久事实（ListPlans 读的也是它），
// 文件头（frontmatter 的 `toolCallId`）记录了「哪个调用落了哪份计划」，因此可以从目录重推导。
// 读目录这一步在运行时（`listSessionPlanFileWrittenFacts`）——workspaceRoot 与会话计划子目录
// 的位置是运行时的知识，协议层不碰文件系统，这里只做事实到事件的映射。
//
// 合成事件与 live 事件同型、走同一个归约路径：投影按 toolCallId 找到那条工具行补上路径，
// 找不到就丢弃（绝不凭空造行）；同一调用已有路径时投影按值去重，重复冷恢复是幂等的。
import {
  SessionEventType as SessionEventTypes,
  type EventId,
  type SessionEvent,
  type SessionId,
  type TraceId,
} from "@zcode/contracts";
import type { SessionPlanFileWrittenFact } from "@zcode/core";

export function synthesizePlanFileWrittenEvents(input: {
  facts: readonly SessionPlanFileWrittenFact[];
  sessionId: string;
}): SessionEvent[] {
  const sessionId = input.sessionId as SessionId;
  return input.facts.map((fact) => ({
    // 确定性 id：同一次冷恢复重复执行产出同一条事件，便于幂等与排查。
    id: `hydrate-plan-file-${fact.planId}` as EventId,
    sessionId,
    type: SessionEventTypes.PlanFileWritten,
    timestamp: new Date(),
    traceId: "trace-hydration" as TraceId,
    sequenceNumber: 0,
    payload: {
      planFilePath: fact.path,
      planId: fact.planId,
      toolCallId: fact.toolCallId,
    },
  }));
}
