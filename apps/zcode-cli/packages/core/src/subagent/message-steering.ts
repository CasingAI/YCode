import type {
  PendingTurnAttachment,
  SubagentAttachment,
  TraceContext,
  TurnSteerInput,
  TurnSteerResult,
} from "@zcode/contracts";
import type { RuntimeTaskMessageSink } from "../runtime-task/registry.js";

interface SteerableRuntime {
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
}

export function createSubagentMessageSink(
  runtime: SteerableRuntime,
  request: { traceContext: TraceContext },
): RuntimeTaskMessageSink {
  return {
    async send(message) {
      const result = await steerSubagentMessage(runtime, request, message);
      if (result.kind === "rejected") {
        throw new Error(`Subagent message rejected: ${result.reason}`);
      }
      return "steered";
    },
  };
}

async function steerSubagentMessage(
  runtime: SteerableRuntime,
  request: { traceContext: TraceContext },
  message: {
    id: string;
    message: string;
    summary?: string;
    attachments?: SubagentAttachment[];
    traceContext?: TraceContext;
  },
): Promise<TurnSteerResult> {
  const input = formatSubagentCoordinatorMessage(message);
  // 运行中转向支持附件：steerTurn 的 TurnSteerInput.attachments 本就存在，
  // 排队消费后与普通 turn 走同一 resolver。附件缺席时保持纯文本，不另起分支。
  const attachments =
    message.attachments === undefined
      ? undefined
      : mapSubagentAttachments(message.attachments);
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runtime.steerTurn({
      delivery: "guide",
      inputPresentation: "coordinator_steer",
      input,
      ...(attachments === undefined ? {} : { attachments }),
      inputId: message.id,
      traceContext: message.traceContext ?? request.traceContext,
    });
    if (result.kind !== "rejected" || result.reason !== "no_active_turn") {
      return result;
    }
    await sleep(10);
  }
  return runtime.steerTurn({
    delivery: "guide",
    inputPresentation: "coordinator_steer",
    input,
    ...(attachments === undefined ? {} : { attachments }),
    inputId: message.id,
    traceContext: message.traceContext ?? request.traceContext,
  });
}

/**
 * contracts 协议附件 → core 运行时附件的字段映射。
 * 两边同构，逐一字段透传；非法形状由下游 resolveTurnAttachments 降级，不在这里抛错。
 */
function mapSubagentAttachments(attachments: SubagentAttachment[]): PendingTurnAttachment[] {
  return attachments.map((attachment) => ({
    type: attachment.type,
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
    ...(attachment.content === undefined ? {} : { content: attachment.content }),
    ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
    ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
    ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
  }));
}

function formatSubagentCoordinatorMessage(message: { message: string; summary?: string }): string {
  const summary = message.summary?.trim();
  if (!summary) return message.message;
  return [summary, "", message.message].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
