import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import { Fragment } from "react";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ContentPartView } from "@/ModelTrajectoryPaneDetails.js";
import { ExpandableTrajectoryMessage } from "@/ModelTrajectoryExpandableMessage.js";
import { groupTrajectoryInputRows, trajectoryRoleLabelId } from "@/ModelTrajectoryMessageOrigin.js";
import { formatTrajectoryDateTime, formatTrajectoryDuration } from "@/ModelTrajectoryFormat.js";
import { trajectoryRoleTextClass } from "@/ModelTrajectoryRoleStyles.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/**
 * 输入区消息行（spec：model-trajectory-message-origin.md「输入区展示结构」）。
 * 输入区是 prompt 组装视图：系统提示词是请求级前缀，独立成块；
 * reminder 没有独立角色，内嵌到所属用户回合；其余按消息行渲染。
 */
export function TrajectoryInputRows({
  messages,
  callStartedAt,
  callDurationMs,
  expansionKeyPrefix,
  intl,
}: {
  messages: ZCodeModelTrajectoryMessage[];
  callStartedAt: string;
  callDurationMs?: number;
  expansionKeyPrefix?: string;
  intl: IntlShape;
}) {
  const rows = groupTrajectoryInputRows(messages);

  return (
    <>
      {rows.map((row, rowIndex) => {
        const divider = rowIndex > 0 ? <TrajectoryRowDivider /> : null;

        if (row.kind === "system-prompt") {
          return (
            <Fragment key="system-prompt">
              {divider}
              <div
                data-trajectory-system-prompt-block=""
                className="col-span-full grid grid-cols-subgrid"
              >
                <div
                  data-trajectory-system-prompt-header=""
                  className="col-span-full flex h-7 items-center gap-1.5 bg-surface/60 px-3 font-mono text-ui-xs uppercase text-foreground-subtle"
                >
                  {intl.formatMessage({ id: "modelTrajectory.systemPromptBlock" })}
                </div>
                {row.messages.map((message) => (
                  <MessageBlock
                    key={`sp:${messages.indexOf(message)}`}
                    message={message}
                    callStartedAt={callStartedAt}
                    callDurationMs={callDurationMs}
                    isAlt={false}
                    expansionKey={
                      expansionKeyPrefix
                        ? `${expansionKeyPrefix}:input:${messages.indexOf(message)}`
                        : undefined
                    }
                    intl={intl}
                  />
                ))}
              </div>
            </Fragment>
          );
        }

        if (row.kind === "message") {
          return (
            <Fragment key={`msg:${messages.indexOf(row.message)}`}>
              {divider}
              <MessageBlock
                message={row.message}
                callStartedAt={callStartedAt}
                callDurationMs={callDurationMs}
                isAlt={rowIndex % 2 === 1}
                expansionKey={
                  expansionKeyPrefix
                    ? `${expansionKeyPrefix}:input:${messages.indexOf(row.message)}`
                    : undefined
                }
                intl={intl}
              />
            </Fragment>
          );
        }

        return (
          <Fragment key={`turn:${messages.indexOf(row.primary)}`}>
            {divider}
            <MessageBlock
              message={row.primary}
              callStartedAt={callStartedAt}
              callDurationMs={callDurationMs}
              isAlt={rowIndex % 2 === 1}
              expansionKey={
                expansionKeyPrefix
                  ? `${expansionKeyPrefix}:input:${messages.indexOf(row.primary)}`
                  : undefined
              }
              intl={intl}
            />
            {row.reminders.map((reminder) => (
              <MessageBlock
                key={`ride:${messages.indexOf(reminder)}`}
                message={reminder}
                callStartedAt={callStartedAt}
                callDurationMs={callDurationMs}
                isAlt={false}
                nested
                expansionKey={
                  expansionKeyPrefix
                    ? `${expansionKeyPrefix}:input:${messages.indexOf(reminder)}`
                    : undefined
                }
                intl={intl}
              />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

export function TrajectoryRowDivider() {
  return <div data-trajectory-row-divider="" className="col-span-full h-px bg-border/50" />;
}

function MessageBlock({
  message,
  callStartedAt,
  callDurationMs,
  isAlt,
  nested = false,
  expansionKey,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  callStartedAt: string;
  callDurationMs?: number;
  isAlt: boolean;
  /** 内嵌在用户回合下的 reminder：缩进并弱化，表达从属关系。 */
  nested?: boolean;
  expansionKey?: string;
  intl: IntlShape;
}) {
  // 只有已知角色才有 i18n key，未知角色直接展示原始 role，避免触发缺失 key；
  // 来源分类（运行时注入 reminder）由 labelId 选择逻辑处理。
  const knownRole = ["system", "user", "assistant", "tool"].includes(message.role);
  const roleLabel = knownRole
    ? intl.formatMessage({ id: trajectoryRoleLabelId(message) })
    : message.role;

  if (
    (message.role === "system" || message.role === "user" || message.role === "tool") &&
    message.parts.length > 0
  ) {
    return (
      <ExpandableTrajectoryMessage
        message={message}
        role={message.role}
        roleLabel={roleLabel}
        nested={nested}
        callDurationLabel={
          typeof callDurationMs === "number" ? formatTrajectoryDuration(callDurationMs) : "—"
        }
        callDatetimeLabel={formatTrajectoryDateTime(callStartedAt)}
        callDatetimeTitle={callStartedAt}
        isAlt={isAlt}
        expansionKey={expansionKey}
        intl={intl}
      />
    );
  }

  return (
    <div
      data-trajectory-message-role={message.role}
      data-trajectory-search-target-key={expansionKey}
      data-trajectory-row-alt={isAlt || undefined}
      className={cn(
        "col-span-full grid min-h-8 min-w-0 grid-cols-subgrid px-3",
        isAlt && "bg-surface/30",
      )}
    >
      <span
        data-trajectory-role-label={knownRole ? message.role : "unknown"}
        className={cn(
          "pr-1 pt-0.5 font-mono text-ui-sm uppercase",
          knownRole
            ? trajectoryRoleTextClass(
                message.role === "tool"
                  ? "tool-result"
                  : (message.role as "system" | "user" | "assistant"),
              )
            : "text-foreground-subtlest",
        )}
      >
        {roleLabel}
      </span>
      <div
        data-trajectory-search-field="content"
        className="col-span-2 flex min-w-0 flex-col gap-1.5"
      >
        {message.parts.length === 0 ? (
          <span className="text-ui-sm text-foreground-subtlest">—</span>
        ) : (
          message.parts.map((part, partIndex) => (
            <ContentPartView key={partIndex} part={part} intl={intl} />
          ))
        )}
      </div>
    </div>
  );
}
