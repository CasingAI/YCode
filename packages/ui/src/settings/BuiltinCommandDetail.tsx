import { Terminal } from "lucide-react";
import type { ModelSelectionView } from "@zcode/services";
import type { BuiltinCommand } from "@zcode/shared";
import { isModelBindableBuiltinSlashCommandName } from "@zcode/shared";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ModelOverrideControl } from "@/settings/ModelOverrideControl.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

export interface BuiltinCommandDetailOverrideProps {
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  /** 接收 picker 值（provider/model 编码）与档位；undefined 模型表示跟随默认。 */
  onPersist: (next: { model?: string; thoughtLevel?: string }) => Promise<void>;
}

/**
 * 系统命令详情页（命令绑定模型详情入口，docs/specs/command-model-binding.md）。
 * 列表行只读展示、可点进入；绑定只在这里改——
 * 只有可绑定名单里的命令挂即改即存控件，其余强制跟随默认，只读说明。
 */
export function BuiltinCommandDetail({
  command,
  modelOverride,
}: {
  command: BuiltinCommand;
  modelOverride: BuiltinCommandDetailOverrideProps;
}) {
  const { intl } = useZCodeIntl();
  const bindable = isModelBindableBuiltinSlashCommandName(command.name);
  // Hook 不能条件调用；不可绑定的行传入空 view 时推荐闭包不会产生候选。
  const recommendSelection = useStartPlanRecommendation(
    bindable ? modelOverride.modelSelectionView : undefined,
    "command",
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
          aria-hidden="true"
        >
          <Terminal className="size-4" />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-ui-xl font-semibold text-foreground">/{command.name}</h3>
          <p className="mt-0.5 text-ui-base text-foreground-subtle">{command.inputHint}</p>
        </div>
      </div>

      <p className="text-ui-base text-foreground">
        {command.description || intl.formatMessage({ id: "settings.commands.noDescription" })}
      </p>

      <section className="space-y-2">
        <h4 className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.commands.builtin.modelSection" })}
        </h4>
        {bindable ? (
          <ModelOverrideControl
            selectionOverride={command.modelSelectionOverride}
            modelGroups={modelOverride.modelGroups}
            modelSelectionView={modelOverride.modelSelectionView}
            modelSelectionLoading={modelOverride.modelSelectionLoading}
            onPersist={modelOverride.onPersist}
            recommendSelection={recommendSelection}
          />
        ) : (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.commands.builtin.inheritOnly" })}
          </p>
        )}
      </section>
    </div>
  );
}
