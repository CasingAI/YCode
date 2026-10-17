import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { encodeCustomModelValue, decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import type { ModelGroupMemberRef } from "@zcode/provider";
import type { ModelGroupMemberCandidateView } from "@zcode/services";
import type { ZCodeConfigOption } from "@zcode/shared";

const MODEL_ITEM_NEVER_LOCKED = () => false;

export interface ModelGroupMemberPickerCandidate extends ModelGroupMemberCandidateView {
  readonly available: boolean;
}

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
  const [selectedValue, setSelectedValue] = useState("");
  const [reasoningLevel, setReasoningLevel] = useState<string | undefined>();
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);

  const selectedCandidate = useMemo(() => {
    const selection = decodeCustomModelValue(selectedValue);
    return selection
      ? candidates.find(
          (candidate) =>
            candidate.providerId === selection.providerId &&
            candidate.modelId === selection.modelName,
        )
      : undefined;
  }, [candidates, selectedValue]);

  useEffect(() => {
    if (!open || !selectedValue) return;
    if (!selectedCandidate) {
      setSelectedValue("");
      setReasoningLevel(undefined);
      return;
    }
    if (reasoningLevel && !selectedCandidate.reasoningLevels.includes(reasoningLevel)) {
      setReasoningLevel(selectedCandidate.defaultReasoningLevel);
    }
  }, [open, reasoningLevel, selectedCandidate, selectedValue]);

  const modelGroups = useMemo<ModelSelectGroup[]>(() => {
    const byProvider = new Map<string, ModelGroupMemberPickerCandidate[]>();
    for (const candidate of candidates) {
      const providerCandidates = byProvider.get(candidate.providerId) ?? [];
      providerCandidates.push(candidate);
      byProvider.set(candidate.providerId, providerCandidates);
    }
    return [...byProvider.entries()].map(([providerId, providerCandidates]) => ({
      key: `model-group-member-provider:${providerId}`,
      label: providerCandidates[0]?.providerLabel ?? providerId,
      items: providerCandidates.map((candidate) => ({
        key: `${candidate.providerId}/${candidate.modelId}`,
        value: encodeCustomModelValue(candidate.providerId, candidate.modelId),
        name: candidate.modelId,
        ...(!candidate.available
          ? { badgeLabel: intl.formatMessage({ id: "settings.modelGroups.memberUnavailable" }) }
          : candidate.providerHidden
            ? { badgeLabel: intl.formatMessage({ id: "settings.modelGroups.memberHidden" }) }
            : undefined),
      })),
    }));
  }, [candidates, intl]);
  const thoughtOption = useMemo<ZCodeConfigOption | null>(() => {
    if (!selectedCandidate || selectedCandidate.reasoningLevels.length === 0) return null;
    return {
      id: "thought_level",
      name: intl.formatMessage({ id: "settings.modelGroups.memberThoughtLevel" }),
      category: "thought_level",
      type: "select",
      currentValue: reasoningLevel ?? "",
      options: selectedCandidate.reasoningLevels.map((level) => ({ value: level, name: level })),
    };
  }, [intl, reasoningLevel, selectedCandidate]);

  useEffect(() => {
    if (!open) {
      setSelectedValue("");
      setReasoningLevel(undefined);
      return;
    }
    if (selectedValue) return;
    const initial = candidates[0];
    if (!initial) return;
    setSelectedValue(encodeCustomModelValue(initial.providerId, initial.modelId));
    setReasoningLevel(initial.defaultReasoningLevel);
  }, [candidates, open, selectedValue]);

  const handleModelChange = (value: string) => {
    const selection = decodeCustomModelValue(value);
    const candidate = selection
      ? candidates.find(
          (item) =>
            item.providerId === selection.providerId && item.modelId === selection.modelName,
        )
      : undefined;
    setSelectedValue(value);
    setReasoningLevel(candidate?.defaultReasoningLevel);
  };

  const handleConfirm = () => {
    if (!selectedCandidate) return;
    const confirmedReasoningLevel = selectedCandidate.reasoningLevels.includes(reasoningLevel ?? "")
      ? reasoningLevel
      : selectedCandidate.defaultReasoningLevel;
    onPick({
      providerId: selectedCandidate.providerId,
      modelId: selectedCandidate.modelId,
      ...(thoughtOption && confirmedReasoningLevel
        ? { reasoningLevel: confirmedReasoningLevel }
        : {}),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid="model-group-member-picker-dialog">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "settings.modelGroups.addMember" })}</DialogTitle>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="py-5 text-center text-ui-base text-muted-foreground">
            {intl.formatMessage({ id: "settings.modelGroups.membersEmpty" })}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <ModelConfigSelect
                modelGroups={modelGroups}
                normalizedValue={selectedValue}
                triggerLabel={
                  selectedCandidate?.modelId ??
                  intl.formatMessage({ id: "settings.modelGroups.pickModelPlaceholder" })
                }
                showProviderLevel
                showManageModelsAction={false}
                lockReasonMessage=""
                isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                onValueChange={handleModelChange}
                contentSide="bottom"
                contentAlign="start"
                focusSelectorOnClose={null}
                labelVisibilityClassName="inline-flex min-w-0"
                triggerClassName="h-9 w-full min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 text-foreground"
                triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
                triggerTestId="model-group-member-model-select"
              />
              {selectedCandidate?.providerHidden ? (
                <Badge variant="outline">
                  {intl.formatMessage({ id: "settings.modelGroups.memberHidden" })}
                </Badge>
              ) : null}
            </div>
            {thoughtOption ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-input-border px-3 py-2">
                <span className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelGroups.memberThoughtLevel" })}
                </span>
                <ThoughtLevelCycleControl
                  intl={intl}
                  option={thoughtOption}
                  triggerRef={levelTriggerRef}
                  interactionMode="select"
                  restoreFocusSelector={null}
                  labelVisibilityClassName="inline-flex"
                  triggerClassName="h-8 rounded-md border border-input-border bg-input px-2 text-foreground"
                  onValueChange={setReasoningLevel}
                />
              </div>
            ) : null}
            {selectedCandidate && !selectedCandidate.available ? (
              <p className="text-ui-sm text-muted-foreground">
                {intl.formatMessage({ id: "settings.modelGroups.memberUnavailableHint" })}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "settings.modelGroups.cancel" })}
          </Button>
          <Button
            type="button"
            disabled={!selectedCandidate}
            onClick={handleConfirm}
            data-testid="model-group-member-picker-confirm"
          >
            {intl.formatMessage({ id: "settings.modelGroups.addMember" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
