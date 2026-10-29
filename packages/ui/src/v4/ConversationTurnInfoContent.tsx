import {
  TID_CHAT_TURN_INFO_MODELS,
  TID_CHAT_TURN_INFO_REASONING_DURATION,
  TID_CHAT_TURN_INFO_STATUS,
  TID_CHAT_TURN_INFO_TOOL_CALLS,
  TID_CHAT_TURN_INFO_TURN_ID,
  TID_CHAT_TURN_INFO_WORK_DURATION,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import type { ConversationTurnInfoFacts } from "@/v4/conversationTurnInfo.js";

const STATE_MESSAGE_IDS = {
  running: "chat.turnInfo.status.running",
  completed: "chat.turnInfo.status.completed",
  interrupted: "chat.turnInfo.status.interrupted",
  failed: "chat.turnInfo.status.failed",
} as const;

/** 只读事实表；未知与明确的 0 必须分开呈现，不从当前选型补值。 */
export function ConversationTurnInfoContent({ facts }: { facts: ConversationTurnInfoFacts }) {
  const { intl, locale } = useZCodeIntl();
  const unknown = intl.formatMessage({ id: "chat.turnInfo.unknown" });

  const formatDuration = (durationMs: number | undefined): string => {
    if (durationMs === undefined) return unknown;
    // 既有工时格式把 0 抬到 1 秒；信息表必须如实保留明确的 0。
    if (durationMs === 0) return intl.formatMessage({ id: "chat.turnInfo.zeroDuration" });
    return formatConversationWorkDuration(durationMs, intl, locale) ?? unknown;
  };
  const formatCount = (count: number | undefined): string =>
    count === undefined ? unknown : String(count);

  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 text-ui-base">
      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "chat.turnInfo.model" })}
      </dt>
      <dd data-testid={TID_CHAT_TURN_INFO_MODELS} className="min-w-0 text-foreground">
        {facts.executionModels.length > 0 ? (
          <ul className="min-w-0 space-y-1">
            {facts.executionModels.map((model) => (
              <li
                key={`${model.providerId}\u0000${model.modelId}`}
                className="min-w-0 break-all font-mono text-ui-sm"
              >
                <span>{model.providerId}</span>
                <span aria-hidden="true" className="px-1 text-foreground-subtle">
                  /
                </span>
                <span>{model.modelId}</span>
              </li>
            ))}
          </ul>
        ) : (
          unknown
        )}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "chat.turnInfo.status" })}
      </dt>
      <dd data-testid={TID_CHAT_TURN_INFO_STATUS} className="min-w-0 text-foreground">
        {facts.workState ? intl.formatMessage({ id: STATE_MESSAGE_IDS[facts.workState] }) : unknown}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "chat.turnInfo.workDuration" })}
      </dt>
      <dd data-testid={TID_CHAT_TURN_INFO_WORK_DURATION} className="min-w-0 text-foreground">
        {formatDuration(facts.durationMs)}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "chat.turnInfo.toolCalls" })}
      </dt>
      <dd data-testid={TID_CHAT_TURN_INFO_TOOL_CALLS} className="min-w-0 text-foreground">
        {formatCount(facts.toolCallCount)}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "chat.turnInfo.reasoningDuration" })}
      </dt>
      <dd data-testid={TID_CHAT_TURN_INFO_REASONING_DURATION} className="min-w-0 text-foreground">
        {formatDuration(facts.reasoningDurationMs)}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "chat.turnInfo.turnId" })}
      </dt>
      <dd data-testid={TID_CHAT_TURN_INFO_TURN_ID} className="min-w-0 text-foreground">
        {facts.turnId.trim() ? (
          <code className="break-all font-mono text-ui-sm">{facts.turnId}</code>
        ) : (
          unknown
        )}
      </dd>
    </dl>
  );
}
