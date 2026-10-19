import type { ModelGroupMemberRef } from "@zcode/provider";
import type { ModelGroupMemberCandidateView } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const THOUGHT_LEVEL_CHIP_CLASS =
  "inline-flex h-5 max-w-40 items-center truncate rounded-md border border-border bg-surface px-1.5 font-mono text-ui-sm text-foreground-subtle";

/**
 * 成员思考深度只读展示（docs/specs/model-group.md）：档位在添加成员时一次确定，
 * 落盘后不可改；要换档位就删掉该成员再重新添加。这里只展示已落盘的档位值，
 * 以及两种失效形态：旧配置未绑定（跟模型当前默认档）、模型已不再支持该档位。
 */
export function ModelGroupMemberThoughtLevel({
  member,
  candidate,
  index,
}: {
  member: ModelGroupMemberRef;
  /** 目录候选；模型已从 Registry 移除时为 undefined，此时无法判定档位是否仍受支持。 */
  candidate: ModelGroupMemberCandidateView | undefined;
  /** 成员序号：同一模型可重复加入，测试标识必须能区分同一条目的多次出现。 */
  index: number;
}) {
  const { intl } = useZCodeIntl();
  const level = member.reasoningLevel?.trim();
  const fixedHint = intl.formatMessage({ id: "settings.modelGroups.memberThoughtLevelFixed" });
  const testId = `model-group-member-thought-${member.providerId}-${member.modelId}-${index}`;

  if (!level) {
    // 旧配置缺字段：运行时按模型当前默认档执行，成员行不提供改值入口。
    return (
      <span
        className={THOUGHT_LEVEL_CHIP_CLASS}
        title={`${intl.formatMessage({ id: "settings.modelGroups.unboundThoughtLevel" })} · ${fixedHint}`}
        data-testid={testId}
      >
        {intl.formatMessage({ id: "settings.modelGroups.defaultThoughtLevel" })}
      </span>
    );
  }

  if (candidate && !candidate.reasoningLevels.includes(level)) {
    // 模型档位表变了：已绑定值不再受支持，成员行只提示，不做原地改值。
    const unsupported = intl.formatMessage(
      { id: "settings.modelGroups.unsupportedThoughtLevel" },
      { level },
    );
    return (
      <span
        className={`${THOUGHT_LEVEL_CHIP_CLASS} border-destructive/40 text-destructive`}
        title={unsupported}
        data-testid={testId}
      >
        {unsupported}
      </span>
    );
  }

  return (
    <span className={THOUGHT_LEVEL_CHIP_CLASS} title={fixedHint} data-testid={testId}>
      {level}
    </span>
  );
}
