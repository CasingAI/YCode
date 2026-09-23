import { createPartId } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import { mergeReasoningForPersistence } from "./reasoning-part-persistence.js";

export async function persistCancelledStreamSnapshot(
  runtime: AgentRuntimeInternal,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    snapshot: RuntimeModelStreamSnapshot;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 用户 stop 时模型请求会以异常退出，成功路径里的最终 text/reasoning
  // 持久化不会执行；这里只 flush 已经到达本进程的 text/reasoning，工具仍等终态路径处理。
  const completedAt = Date.now();
  // 归并单位与成功路径一致：一次模型请求的思考落成一条 part，
  // 否则同一轮思考在直播（一次 closeStreamingRows）和冷恢复（多条 part）之间裂开。
  const reasoningParts = mergeReasoningForPersistence({
    blocks: options.snapshot.reasoning,
    fallbackStart: options.assistantCreatedAt,
    // 终点一律取取消当下：直播侧中断时是 closeStreamingRows(结束事件时刻)，冷恢复必须落在同一个量上。
    // 不采用 provider 早先发过的 reasoning_end——那会漏掉「思考完但用户仍在等」的空档，
    // 重启后秒数比直播时更小。
    resolveEnd: () => completedAt,
  });
  for (const reasoningPart of reasoningParts) {
    await runtime.persistPart(
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
        type: "reasoning",
        text: reasoningPart.text,
        metadata: reasoningPart.metadata,
        time: reasoningPart.time,
      },
      options.traceContext,
    );
  }
  if (!options.snapshot.text) {
    return;
  }
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "text",
      text: options.snapshot.text,
      time: {
        start: options.assistantCreatedAt,
        end: completedAt,
      },
    },
    options.traceContext,
  );
}
