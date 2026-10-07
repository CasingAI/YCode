import { useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelGroupMemberRef } from "@zcode/provider";

/** 添加成员弹窗的扁平候选：与 ModelGroupsSection 的 GroupMemberCandidate 同构，避免跨文件类型导入。 */
export interface ModelGroupMemberPickerCandidate extends ModelGroupMemberRef {
  readonly providerLabel: string;
  readonly available: boolean;
}

/**
 * 添加成员弹窗（docs/specs/model-group.md）：按供应商分组、可搜索；
 * 数据源沿用设置面成员候选，选中映射回 provider/model 二元组提交。
 * 不复用聊天 ModelConfigSelect 实例：数据源与值编码都不同（见 spec）。
 */
export function ModelGroupMemberPickerDialog({
  open,
  onOpenChange,
  candidates,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: readonly ModelGroupMemberPickerCandidate[];
  onPick: (member: ModelGroupMemberRef) => void;
}) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = normalized
      ? candidates.filter((candidate) =>
          `${candidate.providerLabel} ${candidate.modelId}`.toLowerCase().includes(normalized),
        )
      : candidates;
    const byProvider = new Map<string, ModelGroupMemberPickerCandidate[]>();
    for (const candidate of filtered) {
      const list = byProvider.get(candidate.providerLabel) ?? [];
      list.push(candidate);
      byProvider.set(candidate.providerLabel, list);
    }
    return [...byProvider.entries()];
  }, [candidates, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(32rem,calc(100vh-4rem))] grid-rows-[auto_auto_minmax(0,1fr)] overflow-clip sm:max-w-[420px]"
        data-testid="model-group-member-picker-dialog"
      >
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "settings.modelGroups.addMember" })}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest"
            aria-hidden="true"
          />
          <Input
            value={query}
            size="lg"
            className="pl-9"
            placeholder={intl.formatMessage({ id: "settings.modelGroups.pickModelPlaceholder" })}
            aria-label={intl.formatMessage({ id: "settings.modelGroups.pickModelPlaceholder" })}
            data-testid="model-group-member-picker-search"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="min-h-0 overflow-y-auto" data-testid="model-group-member-picker-list">
          {groups.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              {intl.formatMessage({ id: "settings.modelGroups.membersEmpty" })}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map(([providerLabel, items]) => (
                <section key={providerLabel}>
                  <h4 className="mb-1 truncate px-1 text-ui-sm font-semibold text-foreground-subtlest">
                    {providerLabel}
                  </h4>
                  <ul className="flex flex-col overflow-hidden rounded-lg border border-input-border bg-input">
                    {items.map((candidate, index) => (
                      <li key={`${candidate.providerId}/${candidate.modelId}`}>
                        <button
                          type="button"
                          disabled={!candidate.available}
                          data-testid={`model-group-member-picker-item-${candidate.providerId}-${candidate.modelId}`}
                          onClick={() => {
                            onPick({
                              providerId: candidate.providerId,
                              modelId: candidate.modelId,
                            });
                            onOpenChange(false);
                          }}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-ui-base transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60 ${
                            index === items.length - 1 ? "" : "border-b border-input-border"
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate font-mono">
                            {candidate.modelId}
                          </span>
                          {candidate.available ? null : (
                            <Badge
                              variant="outline"
                              className="shrink-0 text-xs text-muted-foreground"
                            >
                              {intl.formatMessage({
                                id: "settings.modelGroups.memberUnavailable",
                              })}
                            </Badge>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "settings.modelGroups.cancel" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
