import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { OpenCodeWorkspaceList } from "@zcode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatOpencodeWorkspaceOption,
  OPENCODE_WORKSPACE_AUTO_VALUE,
  resolveOpencodeWorkspaceTriggerLabel,
  shortenOpencodeWorkspaceId,
} from "./opencodeWorkspaceOptions.js";

/** Cookie 草稿自动拉列表的防抖时长：太短会在粘贴过程中打无效请求。 */
const WORKSPACE_FETCH_DEBOUNCE_MS = 600;

/**
 * 表单字段标签：与 SubagentsSection 的 FormFieldLabel 同一形态，
 * 避免本区块自造一套「标签在左」的行式布局。
 */
function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-ui-base font-medium text-foreground-subtle"
    >
      {children}
    </label>
  );
}

/**
 * OpenCode 凭据配置表单：Cookie 输入 + Workspace 下拉 + 保存/取消/清除。
 *
 * 每次挂载都从 `initialWorkspaceId` 起算草稿：父组件只在「首次未配置」或
 * 用户点开「修改配置」时挂载本组件，关闭即卸载，因此不需要额外的重置协议。
 * Cookie 明文只存在于本组件 state，不进日志、不进持久化层。
 */
export function OpenCodeUsageCredentialForm({
  configured,
  cookieTail,
  initialWorkspaceId,
  saving,
  workspaceList,
  workspaceListLoading,
  fetchWorkspaces,
  saveCredential,
  clearCredential,
  onClose,
}: {
  configured: boolean;
  cookieTail: string;
  initialWorkspaceId: string;
  saving: boolean;
  workspaceList: OpenCodeWorkspaceList;
  workspaceListLoading: boolean;
  fetchWorkspaces: (authCookie: string) => Promise<void>;
  saveCredential: (input: { authCookie: string; workspaceId: string }) => Promise<void>;
  clearCredential: () => Promise<void>;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [cookieDraft, setCookieDraft] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState(initialWorkspaceId);
  const [formErrorId, setFormErrorId] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const cookieInputId = useId();
  const workspaceTriggerId = useId();

  // 父组件每次都传稳定的回调引用，但仍用 ref 兜住，避免把 fetch 放进 effect 依赖。
  const fetchWorkspacesRef = useRef(fetchWorkspaces);
  fetchWorkspacesRef.current = fetchWorkspaces;

  // Cookie 草稿防抖后自动拉 Workspace 列表：草稿非空用草稿（还没点保存），
  // 草稿为空且已配置时用已保存凭据——用户粘贴完 Cookie，下拉就自动就绪。
  // 未配置且没有草稿时无事可拉，跳过请求，避免空白表单一打开就报「Cookie 未生效」。
  useEffect(() => {
    const trimmed = cookieDraft.trim();
    if (trimmed === "" && !configured) return;
    const timer = setTimeout(() => {
      void fetchWorkspacesRef.current(trimmed);
    }, WORKSPACE_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [cookieDraft, configured]);

  const handleSave = async () => {
    const cookieInput = cookieDraft.trim();
    // 已配置时允许留空 = 沿用已保存的 Cookie（改 Workspace / 重新保存不必重贴）。
    if (!cookieInput && !configured) {
      setFormErrorId("settings.modelProvider.opencodeUsage.error.invalidCookie");
      return;
    }
    // Workspace 留空是允许的：host 取 Workspace 列表的第一个 wrk_ 条目作为默认
    // （见 opencodeUsageService.resolveWorkspaceId）。
    setFormErrorId(null);
    try {
      await saveCredential({ authCookie: cookieInput, workspaceId: workspaceDraft });
      // 保存成功后折叠表单；草稿随卸载一并丢弃。
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFormErrorId(
        message.includes("workspace_id")
          ? "settings.modelProvider.opencodeUsage.error.invalidWorkspaceId"
          : "settings.modelProvider.opencodeUsage.error.invalidCookie",
      );
    }
  };

  const workspaceOptions = workspaceList.workspaces;
  // 已保存的选择不在列表里（列表未拉到或远端变了）时补一个兜底项，避免选中值显示丢失。
  const savedSelectionMissing =
    workspaceDraft !== "" && !workspaceOptions.some((option) => option.id === workspaceDraft);

  const workspaceAutoLabel = intl.formatMessage({
    id: "settings.modelProvider.opencodeUsage.workspaceAuto",
  });
  const workspaceTriggerLabel = resolveOpencodeWorkspaceTriggerLabel(
    workspaceDraft,
    workspaceOptions,
    workspaceAutoLabel,
  );

  return (
    <div className="mt-3 space-y-3">
      {/* 首次配置给取法说明；已有凭据时改成「留空即保留」的编辑说明，避免状态错位。 */}
      <p className="text-ui-sm leading-relaxed text-foreground-subtle">
        {intl.formatMessage({
          id: configured
            ? "settings.modelProvider.opencodeUsage.editConfigured"
            : "settings.modelProvider.opencodeUsage.notConfigured",
        })}
      </p>
      <div>
        <FieldLabel htmlFor={cookieInputId}>
          {intl.formatMessage({
            id: "settings.modelProvider.opencodeUsage.cookieLabel",
          })}
        </FieldLabel>
        <Input
          id={cookieInputId}
          type="password"
          size="lg"
          autoComplete="off"
          placeholder={intl.formatMessage(
            {
              id: configured
                ? "settings.modelProvider.opencodeUsage.cookiePlaceholderKeep"
                : "settings.modelProvider.opencodeUsage.cookiePlaceholder",
            },
            { tail: cookieTail },
          )}
          value={cookieDraft}
          onChange={(event) => setCookieDraft(event.target.value)}
        />
      </div>
      <div>
        <FieldLabel htmlFor={workspaceTriggerId}>
          {intl.formatMessage({
            id: "settings.modelProvider.opencodeUsage.workspaceIdLabel",
          })}
        </FieldLabel>
        {/* 选择器与刷新按钮共用一层边框，避免图标按钮看起来是漂在字段外的孤立控件。 */}
        <div className="flex w-full items-stretch overflow-hidden rounded-lg border border-input-border bg-input transition-colors hover:border-input-border-hover focus-within:border-input-border-focused">
          <Select
            value={workspaceDraft === "" ? OPENCODE_WORKSPACE_AUTO_VALUE : workspaceDraft}
            onValueChange={(value) =>
              setWorkspaceDraft(value === OPENCODE_WORKSPACE_AUTO_VALUE ? "" : value)
            }
          >
            <SelectTrigger
              id={workspaceTriggerId}
              size="lg"
              className="h-8 w-auto min-w-0 flex-1 rounded-none border-0 bg-transparent focus-visible:border-0 focus-visible:bg-transparent"
            >
              <SelectValue placeholder={workspaceAutoLabel}>{workspaceTriggerLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OPENCODE_WORKSPACE_AUTO_VALUE}>{workspaceAutoLabel}</SelectItem>
              {workspaceOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {formatOpencodeWorkspaceOption(option.name, option.id)}
                </SelectItem>
              ))}
              {savedSelectionMissing ? (
                <SelectItem value={workspaceDraft}>
                  {shortenOpencodeWorkspaceId(workspaceDraft)}
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
          {/* 刷新只重拉 Workspace 列表（host 侧有 60s 缓存节流），不刷新用量。 */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-none border-l border-input-border text-foreground-subtle"
            aria-label={intl.formatMessage({
              id: "settings.modelProvider.opencodeUsage.workspaceRefresh",
            })}
            title={intl.formatMessage({
              id: "settings.modelProvider.opencodeUsage.workspaceRefresh",
            })}
            disabled={workspaceListLoading || (!configured && cookieDraft.trim() === "")}
            onClick={() => void fetchWorkspacesRef.current(cookieDraft.trim())}
          >
            {workspaceListLoading ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
          </Button>
        </div>
        {workspaceList.error ? (
          <p className="mt-1.5 text-ui-xs text-warning" role="alert">
            {intl.formatMessage({
              id: "settings.modelProvider.opencodeUsage.workspaceListError",
            })}
          </p>
        ) : null}
      </div>
      {formErrorId ? (
        <p className="text-ui-xs text-warning" role="alert">
          {intl.formatMessage({ id: formErrorId })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
          {intl.formatMessage({
            id: "settings.modelProvider.opencodeUsage.save",
          })}
        </Button>
        {configured ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {intl.formatMessage({
              id: "settings.modelProvider.opencodeUsage.cancel",
            })}
          </Button>
        ) : null}
      </div>
      {/* 清除凭据是破坏性操作，与「保存/取消」分行并走确认弹窗，避免与取消同级误点。 */}
      {configured ? (
        <div className="border-t border-border pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-ui-sm text-warning"
            onClick={() => setClearConfirmOpen(true)}
          >
            {intl.formatMessage({
              id: "settings.modelProvider.opencodeUsage.clear",
            })}
          </Button>
        </div>
      ) : null}
      <AlertDialog
        open={clearConfirmOpen}
        onOpenChange={(next) => {
          if (!next) setClearConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({
                id: "settings.modelProvider.opencodeUsage.clearConfirmTitle",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({
                id: "settings.modelProvider.opencodeUsage.clearConfirmDescription",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" size="sm">
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              size="sm"
              onClick={(event) => {
                // 阻止 Radix 点击后立即关闭：清除是异步操作，收起时机由父层状态决定。
                event.preventDefault();
                setClearConfirmOpen(false);
                onClose();
                void clearCredential();
              }}
            >
              {intl.formatMessage({
                id: "settings.modelProvider.opencodeUsage.clearConfirmAction",
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
