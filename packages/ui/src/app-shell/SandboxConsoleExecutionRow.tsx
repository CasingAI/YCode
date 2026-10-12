import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SandboxConsoleSnapshot } from "@zcode/shared/zcode-protocol-v4";

const EXECUTION_SOURCE_TEXT_CLASS =
  "min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground";

type SandboxConsoleExecution = SandboxConsoleSnapshot["executions"][number];

/** 执行行源码：摘要保留换行；全文只进只读专用视图，不在标题里再画一遍。 */
export function SandboxConsoleExecutionRow({
  row,
  expanded,
  onToggle,
}: {
  row: SandboxConsoleExecution;
  expanded: boolean;
  onToggle: (seq: number) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <li
      data-testid="sandbox-console-execution"
      data-source={row.source}
      className="min-w-0 rounded-lg bg-surface px-2 py-1.5"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          data-testid="sandbox-console-execution-source"
          data-source={row.source}
          className={
            row.source === "model"
              ? "shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs text-foreground-subtle"
              : "shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-ui-xs text-foreground"
          }
        >
          {intl.formatMessage({
            id:
              row.source === "model"
                ? "sandboxConsole.source.model"
                : "sandboxConsole.source.user",
          })}
        </span>
        {row.truncated ? (
          <button
            type="button"
            data-testid="sandbox-console-execution-toggle"
            aria-expanded={expanded}
            aria-label={intl.formatMessage({
              id: expanded
                ? "sandboxConsole.execution.collapse"
                : "sandboxConsole.execution.expand",
            })}
            onClick={() => onToggle(row.seq)}
            className="flex min-w-0 flex-1 items-start gap-1 text-left"
          >
            <span data-testid="sandbox-console-execution-preview" className={EXECUTION_SOURCE_TEXT_CLASS}>
              {row.preview}
            </span>
            {expanded ? (
              <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
            )}
          </button>
        ) : (
          <span data-testid="sandbox-console-execution-preview" className={EXECUTION_SOURCE_TEXT_CLASS}>
            {row.preview}
          </span>
        )}
      </div>
      {expanded && row.truncated ? (
        <pre
          data-testid="sandbox-console-execution-full"
          className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-panel px-2 py-1.5 font-mono text-ui-sm text-foreground"
        >
          {row.code}
        </pre>
      ) : null}
    </li>
  );
}
