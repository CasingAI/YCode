// resumeSuspendedTurn 命令组：错误横幅「继续」（spec session-error-banner-continue.md §4）。
//
// 「继续」不是重发输入，而是把失败的那个 turn 原地复活：同一个 turnId、同一个用户消息、
// turnNumber 不变，模型重跑时看到的上下文与失败前那次请求逐字相同。不以用户身份发任何
// 消息（不写 user message、不发 TurnStarted），模型也感知不到发生过网络问题。
//
// 失败轮的全部事实都在持久转录里（失败 assistant 消息的 anchor.turnId + parentID），
// 所以这里没有任何内存挂起态：重启、冷恢复之后照样能继续。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

export class V4ResumeSuspendedRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "V4ResumeSuspendedRejectedError";
  }
}

/**
 * resumeSuspendedTurn：把 failedTurnId 指向的失败轮原地续跑。
 *
 * 拒绝只有一种：这一轮压根没有可续跑的失败记录（goal continuation、background wake 等
 * 没有用户原文的维护轮）。必须以 reasonCode 明确拒绝 —— UI 要把它显示成
 * chat.error.continueFailed，不允许只写日志让用户看到「点了没反应」。
 */
async function resumeSuspendedTurn(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resumeSuspendedTurn"];
  const record = requireRecord(host, envelope.sessionId);
  const failedTurnId = payload.failedTurnId;
  try {
    const { completion } = await record.app.runtime.beginResumeFailedTurn({
      failedTurnId,
      inputId: envelope.commandId,
      traceContext: record.traceContext,
    });
    // ack 已经发出（TurnResumed 落库、横幅消失）。整轮跑完与否由 TurnComplete/TurnError
    // 事件表达，这里只把异常收进日志，不能让后台 promise 变成 unhandled rejection。
    void completion.catch((error: unknown) => {
      host.logger?.warn?.("v4 resumed turn failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        failedTurnId,
        inputId: envelope.commandId,
        sessionId: record.app.sessionId,
      });
    });
  } catch (error) {
    throw new V4ResumeSuspendedRejectedError(
      "fault.command.resumeSuspendedRejected.notResumable",
      `resumeSuspendedTurn rejected: ${error instanceof Error ? error.message : String(error)} (failedTurnId=${failedTurnId})`,
    );
  }
  return {
    type: "inputAccepted",
    delivery: "startNow",
    inputId: envelope.commandId,
  };
}

export const resumeSuspendedHandlers = { resumeSuspendedTurn };