/* eslint-disable max-lines -- 模型组设置页集中编排主从导航、组名编辑与成员增删排序（docs/specs/model-group.md）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock3, InfoIcon, Layers, Loader2, Plus, X } from "lucide-react";
import {
  isModelGroupEnabled,
  isModelGroupsPrimary,
  type ModelGroupMemberRef,
  type ProviderSettingsView,
} from "@zcode/provider";
import type { ModelGroupMemberCandidateView } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Badge } from "@/components/ui/badge.js";
import { useModelGroupMemberCandidates } from "@/hooks/useProviderSettingsView.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { logger } from "@/logger.js";
import { SettingsDetailHeaderMenu } from "@/settings/SettingsDetailHeaderMenu.js";
import { SettingsMasterDetailLayout } from "@/settings/SettingsMasterDetailLayout.js";
import {
  SettingsSortableNav,
  type SettingsSortableNavItem,
} from "@/settings/SettingsSortableNav.js";
import { useOptimisticReorder } from "@/settings/useOptimisticReorder.js";
import {
  ModelGroupMemberSortableList,
  ModelGroupMemberSortableRow,
} from "@/settings/ModelGroupMemberSortable.js";
import {
  buildModelGroupMemberOrderEntries,
  resolveModelGroupMemberOrder,
} from "@/settings/modelGroupMemberOrder.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { ModelGroupMemberPickerDialog } from "@/settings/ModelGroupMemberPickerDialog.js";
import { ModelGroupMemberThoughtLevel } from "@/settings/ModelGroupMemberThoughtLevel.js";
import { ModelGroupMemberScheduleDialog } from "@/settings/ModelGroupMemberScheduleDialog.js";
import { Switch } from "@/components/ui/switch.js";
import {
  prepareModelGroupMemberScheduleUpdate,
  updateModelGroupMemberAtIndex,
  withModelGroupMemberSelectable,
} from "@/settings/modelGroupMemberSelectionSettings.js";
import type { ModelGroupDeprioritizeSchedule } from "@zcode/provider";
import { ProviderEnabledToggle } from "@/settings/model-provider-section/ProviderEnabledToggle.js";
import { SectionPrimaryToggle } from "@/settings/model-provider-section/SectionPrimaryToggle.js";

function sameMemberRef(left: ModelGroupMemberRef, right: ModelGroupMemberRef): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function isMemberCandidateAvailable(candidate: ModelGroupMemberCandidateView): boolean {
  return (
    candidate.providerEnabled &&
    candidate.providerExecutable &&
    candidate.modelEnabled &&
    candidate.modelExecutable
  );
}

export function ModelGroupsSection() {
  const { intl } = useZCodeIntl();
  const { providerSettingsService } = useServices();
  const requestConfirmation = useConfirmDialog();
  const providerSettingsRead = useProviderSettingsServiceView(providerSettingsService);
  const memberCandidatesRead = useModelGroupMemberCandidates(providerSettingsService);
  const view =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const modelGroups = useMemo(() => view?.modelGroups ?? [], [view]);
  const memberCandidates = memberCandidatesRead.candidates.map((candidate) => ({
    ...candidate,
    available: isMemberCandidateAvailable(candidate),
  }));

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  // 选中组跟随数据收敛：删除/清空后回第一个组；数据未到时保持 null。
  useEffect(() => {
    if (modelGroups.length === 0) {
      setSelectedGroupId((current) => (current === null ? current : null));
      return;
    }
    if (
      selectedGroupId === null ||
      !modelGroups.some((group) => group.groupId === selectedGroupId)
    ) {
      setSelectedGroupId(modelGroups[0]!.groupId);
    }
  }, [modelGroups, selectedGroupId]);
  const selectedGroup = modelGroups.find((group) => group.groupId === selectedGroupId) ?? null;
  // 重复成员各自生成唯一 id，拖拽只搬运 id，不认模型身份。
  const memberEntries = useMemo(
    () => buildModelGroupMemberOrderEntries(selectedGroup?.memberOrder ?? []),
    [selectedGroup],
  );
  const memberIds = useMemo(() => memberEntries.map((entry) => entry.id), [memberEntries]);

  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  // 创建窗内的局部错误：重名提示留在窗内，不污染页面级 actionError。
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // 添加成员走弹窗选择器：打开态独立于创建窗，选中后映射回二元组提交。
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [scheduleEditor, setScheduleEditor] = useState<{
    groupId: string;
    memberIndex: number;
    memberOrderSnapshot: readonly ModelGroupMemberRef[];
    schedule: ModelGroupDeprioritizeSchedule | undefined;
  } | null>(null);
  const mountedRef = useRef(true);
  // 输入法候选确认也会发出 Enter：部分平台 isComposing 过早恢复 false，靠 ref 兜底避免误提交。
  const compositionActiveRef = useRef(false);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const runMutation = useCallback(
    // 返回是否成功：创建窗靠它决定成功关窗还是留窗展示错误。
    async (action: () => Promise<ProviderSettingsView>): Promise<boolean> => {
      setBusy(true);
      setActionError(null);
      try {
        const nextView = await action();
        // mutation 返回值是权威 View；与 onDidChange 事件收敛共用 revision 守卫。
        providerSettingsRead.commit(nextView);
        return true;
      } catch (error) {
        logger.warn("[ModelGroupsSection] 模型组配置保存失败", { error });
        if (mountedRef.current) {
          setActionError(error instanceof Error ? error.message : String(error));
        }
        return false;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [providerSettingsRead],
  );

  const openCreateDialog = useCallback(() => {
    setCreating(true);
    setCreateName("");
    setCreateError(null);
  }, []);

  const closeCreateDialog = useCallback(() => {
    setCreating(false);
    setCreateName("");
    setCreateError(null);
  }, []);

  const handleCreate = useCallback(() => {
    const name = createName.trim();
    if (!name || busy) return;
    if (modelGroups.some((group) => group.name === name)) {
      // 重名不落页面级错误提示，直接留在创建窗内，方便用户就地改名重试。
      setCreateError(intl.formatMessage({ id: "settings.modelGroups.duplicateName" }));
      return;
    }
    setCreateError(null);
    void runMutation(async () => {
      const nextView = await providerSettingsService.createModelGroup({ name });
      const created = nextView.modelGroups.find((group) => group.name === name);
      if (created) setSelectedGroupId(created.groupId);
      return nextView;
      // 创建成功才关窗：失败时窗保留，错误转写进窗内展示。
    }).then((succeeded) => {
      if (succeeded && mountedRef.current) closeCreateDialog();
    });
  }, [
    busy,
    closeCreateDialog,
    createName,
    intl,
    modelGroups,
    providerSettingsService,
    runMutation,
  ]);

  // 创建窗内的展示错误：优先窗内重名提示，其次页面级 actionError（创建失败时转写进来）。
  const createDialogError = createError ?? actionError;

  const handleRename = useCallback(
    (groupId: string, nextName: string) => {
      const name = nextName.trim();
      const current = modelGroups.find((group) => group.groupId === groupId);
      if (!current || !name || name === current.name) {
        setRenameDraft(null);
        return;
      }
      if (modelGroups.some((group) => group.name === name)) {
        setActionError(intl.formatMessage({ id: "settings.modelGroups.duplicateName" }));
        return;
      }
      setRenameDraft(null);
      void runMutation(() => providerSettingsService.renameModelGroup(groupId, name));
    },
    [intl, modelGroups, providerSettingsService, runMutation],
  );

  const handleDelete = useCallback(
    async (groupId: string) => {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "settings.modelGroups.deleteConfirmTitle" }),
        description: intl.formatMessage({ id: "settings.modelGroups.deleteConfirmDescription" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      await runMutation(() => providerSettingsService.deleteModelGroup(groupId));
    },
    [intl, providerSettingsService, requestConfirmation, runMutation],
  );

  const handleReorderGroupIds = useCallback(
    (groupIds: string[]) => {
      return runMutation(() => providerSettingsService.reorderModelGroups(groupIds)).then(
        () => undefined,
      );
    },
    [providerSettingsService, runMutation],
  );

  // 头部启用开关：关闭后组离开选择器但保留配置与标记，重开恢复。
  const handleSetGroupEnabled = useCallback(
    (enabled: boolean) => {
      if (!selectedGroup || busy) return;
      void runMutation(() =>
        providerSettingsService.setModelGroupEnabled(selectedGroup.groupId, enabled),
      );
    },
    [busy, providerSettingsService, runMutation, selectedGroup],
  );

  // 整节 Primary：只决定「模型组」分节在选择器中一级展开还是收进二级，不看当前选了哪个组。
  const handleSetSectionPrimary = useCallback(
    (isPrimary: boolean) => {
      if (busy) return;
      void runMutation(() => providerSettingsService.setModelGroupsPrimary(isPrimary));
    },
    [busy, providerSettingsService, runMutation],
  );

  // 共享导航行：行首统一 Layers 图标，行尾成员数；选中、拖拽、窄屏收纳走公共组件。
  const navGroups = useMemo(
    () => [
      {
        id: "model-groups",
        items: modelGroups.map(
          (group): SettingsSortableNavItem => ({
            key: group.groupId,
            label: group.name,
            testId: `model-group-nav-${group.groupId}`,
            icon: <Layers className="size-4 shrink-0" aria-hidden="true" />,
            trailing: (
              <span className="text-xs text-muted-foreground">({group.memberOrder.length})</span>
            ),
          }),
        ),
      },
    ],
    [modelGroups],
  );

  const handleSetMembers = useCallback(
    (groupId: string, memberOrder: readonly ModelGroupMemberRef[]) => {
      void runMutation(() => providerSettingsService.setModelGroupMembers(groupId, memberOrder));
    },
    [providerSettingsService, runMutation],
  );

  // 拖拽落下即提交新顺序，写入路径仍是 setModelGroupMembers（唯一写入口）。
  // 乐观顺序可能与权威顺序不同，这里按 id 还原成员；旧快照（id 缺失或数量不符）
  // 直接失败关闭，不提交残缺名单。持久化失败同样抛出，让乐观顺序回落到权威名单。
  const memberOrderPersistContextRef = useRef({
    entries: memberEntries,
    groupId: selectedGroup?.groupId ?? null,
    runMutation,
  });
  memberOrderPersistContextRef.current = {
    entries: memberEntries,
    groupId: selectedGroup?.groupId ?? null,
    runMutation,
  };
  const persistMemberOrder = useCallback(
    async (nextIds: readonly string[]) => {
      const {
        entries,
        groupId,
        runMutation: persistRunMutation,
      } = memberOrderPersistContextRef.current;
      if (!groupId) return;
      const members = resolveModelGroupMemberOrder(entries, nextIds);
      if (!members) {
        throw new Error("Model group member order is stale; skip reorder");
      }
      const succeeded = await persistRunMutation(() =>
        providerSettingsService.setModelGroupMembers(groupId, members),
      );
      if (!succeeded) {
        throw new Error("Model group member reorder failed");
      }
    },
    [providerSettingsService],
  );
  const optimisticMemberOrder = useOptimisticReorder({
    authoritativeIds: memberIds,
    persist: persistMemberOrder,
  });
  const renderedMemberEntries = useMemo(() => {
    const entryById = new Map(memberEntries.map((entry) => [entry.id, entry] as const));
    return optimisticMemberOrder.renderedIds.flatMap((id) => {
      const entry = entryById.get(id);
      return entry ? [entry] : [];
    });
  }, [memberEntries, optimisticMemberOrder.renderedIds]);

  const handleSetMemberSelectable = useCallback(
    (index: number, selectable: boolean) => {
      if (!selectedGroup || busy) return;
      const memberOrder = updateModelGroupMemberAtIndex(
        selectedGroup.memberOrder,
        index,
        (member) => withModelGroupMemberSelectable(member, selectable),
      );
      handleSetMembers(selectedGroup.groupId, memberOrder);
    },
    [busy, handleSetMembers, selectedGroup],
  );

  const handleSaveMemberSchedule = useCallback(
    async (
      groupId: string,
      index: number,
      memberOrderSnapshot: readonly ModelGroupMemberRef[],
      schedule: ModelGroupDeprioritizeSchedule | undefined,
    ): Promise<"saved" | "changed" | "failed"> => {
      if (selectedGroup?.groupId !== groupId) return "changed";
      const update = prepareModelGroupMemberScheduleUpdate(
        selectedGroup.memberOrder,
        memberOrderSnapshot,
        index,
        schedule,
      );
      if (update.kind === "changed") return "changed";
      if (busy) return "failed";
      const memberOrder = update.memberOrder;
      const succeeded = await runMutation(() =>
        providerSettingsService.setModelGroupMembers(groupId, memberOrder),
      );
      return succeeded ? "saved" : "failed";
    },
    [busy, providerSettingsService, runMutation, selectedGroup],
  );
  const handleScheduleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !busy) setScheduleEditor(null);
    },
    [busy],
  );

  const selectedMembers = selectedGroup?.memberOrder ?? [];
  // 添加成员候选 = 全部成员候选（只列具体模型，组不是供应商）。
  // 同一模型允许重复加入：档位在添加时固定，同模型不同档位各算一条成员，
  // 所以这里不按 provider+model 排除组内已有成员。
  const addableCandidates = memberCandidates;

  if (providerSettingsRead.state.status === "error") {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {providerSettingsRead.state.error.message}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {intl.formatMessage({ id: "settings.modelGroups.description" })}
        </p>
        <SettingsResourceHeaderActions
          // 新建走系统 Dialog 小窗：只填一个组名，不占用详情区；窄屏同样居中可用。
          onNew={openCreateDialog}
          newDisabled={busy}
          newLabel={intl.formatMessage({ id: "settings.modelGroups.create" })}
          newActionId="settings.model-groups.create.open"
        />
      </div>
      {actionError && !creating ? (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
      <SettingsMasterDetailLayout
        minHeightClassName="min-h-[28rem]"
        navigation={
          modelGroups.length === 0 ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <p className="hidden px-2 py-6 text-center text-sm text-muted-foreground md:block">
                  {intl.formatMessage({ id: "settings.modelGroups.emptyTitle" })}
                </p>
              </div>
            </div>
          ) : (
            <SettingsSortableNav
              groups={navGroups}
              selectedKey={selectedGroupId}
              disabled={busy}
              onSelect={(item) => setSelectedGroupId(item.key)}
              onReorderIds={(groupIds) => handleReorderGroupIds(groupIds)}
            />
          )
        }
      >
        {selectedGroup === null ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {intl.formatMessage({ id: "settings.modelGroups.emptyDescription" })}
          </div>
        ) : (
          <div className="space-y-3">
            {renameDraft === null ? (
              <SettingsDetailHeaderMenu
                title={selectedGroup.name}
                renameLabel={intl.formatMessage({ id: "settings.modelGroups.rename" })}
                onRename={() => setRenameDraft(selectedGroup.name)}
                onDelete={() => void handleDelete(selectedGroup.groupId)}
                disabled={busy}
                trailing={
                  <ProviderEnabledToggle
                    enabled={isModelGroupEnabled(selectedGroup)}
                    saving={busy}
                    onCheckedChange={(enabled) => void handleSetGroupEnabled(enabled)}
                  />
                }
              />
            ) : (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Input
                  autoFocus
                  value={renameDraft}
                  placeholder={intl.formatMessage({
                    id: "settings.modelGroups.namePlaceholder",
                  })}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleRename(selectedGroup.groupId, renameDraft);
                    if (event.key === "Escape") setRenameDraft(null);
                  }}
                  className="min-w-0 flex-1 basis-40"
                />
                <span className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !renameDraft.trim()}
                    onClick={() => handleRename(selectedGroup.groupId, renameDraft)}
                  >
                    {intl.formatMessage({ id: "settings.modelGroups.save" })}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenameDraft(null)}>
                    {intl.formatMessage({ id: "settings.modelGroups.cancel" })}
                  </Button>
                </span>
              </div>
            )}

            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelGroups.membersLabel" })}
                  </span>
                  <span className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelGroups.existingSessionsHint" })}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="default"
                  className="rounded-lg"
                  data-testid="model-group-add-member-button"
                  disabled={busy || addableCandidates.length === 0}
                  onClick={() => setMemberPickerOpen(true)}
                >
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.modelGroups.addMember" })}
                </Button>
              </div>
              {selectedMembers.length > 0 ? (
                <div className="overflow-hidden rounded-lg border border-input-border bg-input">
                  <ModelGroupMemberSortableList
                    // 使用当前渲染顺序（乐观顺序可能领先于权威顺序），
                    // 拖拽落点与 SortableContext 的几何保持一致。
                    ids={optimisticMemberOrder.renderedIds}
                    disabled={busy}
                    className="flex flex-col"
                    onReorder={(nextIds) => {
                      void optimisticMemberOrder.commit(nextIds).catch(() => undefined);
                    }}
                  >
                    {renderedMemberEntries.map((entry, renderedIndex) => {
                      const member = entry.member;
                      // 乐观顺序可能与权威顺序不同：开关、时段、移除都必须落到
                      // 该成员的权威下标，否则会把策略写到别的成员身上。
                      const memberIndex = memberIds.indexOf(entry.id);
                      const candidate = memberCandidates.find((item) =>
                        sameMemberRef(item, member),
                      );
                      const isLast = renderedIndex === renderedMemberEntries.length - 1;
                      return (
                        <ModelGroupMemberSortableRow
                          key={entry.id}
                          id={entry.id}
                          disabled={busy}
                          className={`space-y-2 px-3 py-2 ${isLast ? "" : "border-b border-input-border"}`}
                        >
                          {(handle) => (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              {handle}
                              <div className="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="min-w-0 truncate font-mono text-ui-base text-foreground">
                                  {member.modelId}
                                </span>
                                <span
                                  className="inline-flex h-5 max-w-40 items-center truncate rounded-md border border-border bg-surface px-1.5 font-mono text-ui-sm text-foreground-subtle"
                                  title={candidate?.providerLabel ?? member.providerId}
                                >
                                  {candidate?.providerLabel ?? member.providerId}
                                </span>
                                {candidate?.providerHidden ? (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 text-ui-xs text-muted-foreground"
                                  >
                                    {intl.formatMessage({
                                      id: "settings.modelGroups.memberHidden",
                                    })}
                                  </Badge>
                                ) : null}
                                {candidate && !candidate.available ? (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 text-ui-xs text-muted-foreground"
                                  >
                                    {intl.formatMessage({
                                      id: "settings.modelGroups.memberUnavailable",
                                    })}
                                  </Badge>
                                ) : null}
                                {member.reasoningLevel ||
                                (candidate && candidate.reasoningLevels.length > 0) ? (
                                  <ModelGroupMemberThoughtLevel
                                    member={member}
                                    candidate={candidate}
                                    index={memberIndex}
                                  />
                                ) : null}
                              </div>
                              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-ui-sm text-foreground-subtle">
                                    {intl.formatMessage({
                                      id: "settings.modelGroups.selectable",
                                    })}
                                  </span>
                                  <Switch
                                    checked={member.selectable !== false}
                                    disabled={busy}
                                    aria-label={intl.formatMessage({
                                      id: "settings.modelGroups.selectable",
                                    })}
                                    onCheckedChange={(checked) =>
                                      handleSetMemberSelectable(memberIndex, checked)
                                    }
                                  />
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  aria-label={intl.formatMessage({
                                    id: "settings.modelGroups.scheduleEdit",
                                  })}
                                  onClick={() =>
                                    setScheduleEditor({
                                      groupId: selectedGroup.groupId,
                                      memberIndex,
                                      memberOrderSnapshot: structuredClone(
                                        selectedGroup.memberOrder,
                                      ),
                                      schedule: member.deprioritizeSchedule,
                                    })
                                  }
                                >
                                  <Clock3 className="size-3.5" aria-hidden="true" />
                                  <span className="text-ui-sm">
                                    {intl.formatMessage({
                                      id: member.deprioritizeSchedule
                                        ? "settings.modelGroups.scheduleEdit"
                                        : "settings.modelGroups.scheduleAdd",
                                    })}
                                  </span>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={intl.formatMessage({
                                    id: "settings.modelGroups.removeMember",
                                  })}
                                  disabled={busy}
                                  onClick={() =>
                                    handleSetMembers(
                                      selectedGroup.groupId,
                                      selectedMembers.filter((_, i) => i !== memberIndex),
                                    )
                                  }
                                >
                                  <X className="size-3.5" />
                                </Button>
                              </div>
                            </div>
                          )}
                        </ModelGroupMemberSortableRow>
                      );
                    })}
                  </ModelGroupMemberSortableList>
                </div>
              ) : null}
              {selectedMembers.length === 0 ? (
                <div className="mt-1 flex h-12 items-center justify-start gap-2 rounded-lg border border-dashed border-border px-4 text-left text-ui-base text-foreground-subtle">
                  <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.modelGroups.membersEmpty" })}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </SettingsMasterDetailLayout>
      {/* 整节 Primary 放页底：决定「模型组」分节在选择器中一级展开还是收进二级，不看当前选了哪个组。 */}
      <SectionPrimaryToggle
        primary={isModelGroupsPrimary(view?.modelGroupsPrimary)}
        saving={busy}
        onCheckedChange={(isPrimary) => void handleSetSectionPrimary(isPrimary)}
        label={intl.formatMessage({ id: "settings.modelGroups.primary" })}
        hint={intl.formatMessage({ id: "settings.modelGroups.primaryHint" })}
        testId="model-groups-primary-switch"
      />
      <ModelGroupMemberPickerDialog
        open={memberPickerOpen}
        onOpenChange={setMemberPickerOpen}
        candidates={addableCandidates}
        onPick={(member) => {
          if (selectedGroup) {
            handleSetMembers(selectedGroup.groupId, [...selectedMembers, member]);
          }
        }}
      />
      <ModelGroupMemberScheduleDialog
        open={scheduleEditor !== null}
        saving={busy}
        schedule={scheduleEditor?.schedule}
        onOpenChange={handleScheduleOpenChange}
        onSave={(schedule) => {
          if (!scheduleEditor) return Promise.resolve("changed");
          return handleSaveMemberSchedule(
            scheduleEditor.groupId,
            scheduleEditor.memberIndex,
            scheduleEditor.memberOrderSnapshot,
            schedule,
          );
        }}
      />
      {/* 新建走系统 Dialog 小窗：只填一个组名，不占用详情区；窄屏居中浮层同样可用。 */}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) closeCreateDialog();
        }}
      >
        <DialogContent className="sm:max-w-[420px]" data-testid="model-group-create-dialog">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: "settings.modelGroups.create" })}</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleCreate();
            }}
          >
            <Input
              autoFocus
              value={createName}
              size="lg"
              placeholder={intl.formatMessage({ id: "settings.modelGroups.namePlaceholder" })}
              aria-label={intl.formatMessage({ id: "settings.modelGroups.nameLabel" })}
              data-testid="model-group-create-dialog-input"
              onChange={(event) => {
                setCreateName(event.target.value);
                // 用户改名后清除窗内重名提示，允许就地重试。
                if (createError) setCreateError(null);
              }}
              onCompositionStart={() => {
                compositionActiveRef.current = true;
              }}
              onCompositionEnd={() => {
                compositionActiveRef.current = false;
              }}
              onKeyDown={(event) => {
                // 输入法候选确认的 Enter 不提交，等用户真正确认组名后再保存。
                if (
                  event.key === "Enter" &&
                  isImeComposingKeyEvent({
                    compositionActive: compositionActiveRef.current,
                    nativeEvent: event.nativeEvent,
                  })
                ) {
                  return;
                }
              }}
            />
            {createDialogError ? (
              <p className="text-sm text-destructive" role="alert">
                {createDialogError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={busy}
                onClick={closeCreateDialog}
              >
                {intl.formatMessage({ id: "settings.modelGroups.cancel" })}
              </Button>
              <Button
                type="submit"
                size="lg"
                data-testid="model-group-create-dialog-submit"
                disabled={busy || !createName.trim()}
              >
                {busy ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
                ) : null}
                {intl.formatMessage({ id: "settings.modelGroups.save" })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
