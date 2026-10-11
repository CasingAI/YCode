import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

/**
 * 「从空目录开始」的落点固定为 ~/YCodeProject/<名称>，
 * 与服务层 createScratchWorkspace 的 mkdir 位置保持一致。
 */
export function getScratchWorkspaceLocationHint(name: string) {
  return `~/YCodeProject/${name.trim()}`;
}

/**
 * 名称校验：空名与路径分隔符都不允许，返回 i18n key 后缀；通过校验返回 null。
 */
export function getScratchWorkspaceNameErrorKind(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "required";
  }

  if (/[\\/]/.test(trimmedName)) {
    return "separator";
  }

  return null;
}

type ScratchWorkspaceErrorKind = "required" | "separator" | "createFailed";

/**
 * 「从空目录开始」新建工作区对话框：UI 只提交名称，空目录创建由 services.fileService 负责。
 * 取消或关闭不产生任何创建请求（onCreate 只在确认时触发）。
 */
export function ChatEmptyWorkspaceCreateDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 返回创建后的 workspace 路径；壳层未开放创建能力时返回 null。 */
  onCreate: (name: string) => Promise<string | null>;
}) {
  const { intl } = useZCodeIntl();
  const [nameDraft, setNameDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [errorKind, setErrorKind] = useState<ScratchWorkspaceErrorKind | null>(null);
  const compositionActiveRef = useRef(false);

  // 每次打开重置为初始态：这是「新建」入口，不保留上次草稿与错误。
  useEffect(() => {
    if (open) {
      setNameDraft("");
      setPending(false);
      setErrorKind(null);
    }
  }, [open]);

  const submit = () => {
    if (pending) {
      return;
    }

    const validationError = getScratchWorkspaceNameErrorKind(nameDraft);
    if (validationError) {
      setErrorKind(validationError);
      return;
    }

    setPending(true);
    void onCreate(nameDraft.trim())
      .then((createdPath) => {
        setPending(false);
        if (createdPath === null) {
          // 壳层拒绝创建时保持对话框打开并提示，避免「按下确认却毫无反应」。
          setErrorKind("createFailed");
          return;
        }
        onOpenChange(false);
      })
      .catch(() => {
        setPending(false);
        setErrorKind("createFailed");
      });
  };

  const errorMessage = errorKind
    ? intl.formatMessage({ id: `chat.empty.createWorkspace.error.${errorKind}` })
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) {
          // 创建请求进行中不允许误关，避免「对话框没了、请求还在飞」的无反馈状态。
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-md overflow-hidden rounded-2xl p-0">
        <div className="flex min-w-0 flex-col gap-5 p-6">
          <DialogHeader className="space-y-2">
            <DialogTitle>
              {intl.formatMessage({ id: "chat.empty.createWorkspace.title" })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-2">
            <Input
              autoFocus
              className="min-w-0"
              size="lg"
              value={nameDraft}
              aria-invalid={errorKind !== null}
              placeholder={intl.formatMessage({ id: "chat.empty.createWorkspace.placeholder" })}
              onChange={(event) => {
                setNameDraft(event.target.value);
                // 重新输入即清掉上一次错误，避免错误态和当前输入内容脱节。
                setErrorKind(null);
              }}
              onCompositionStart={() => {
                compositionActiveRef.current = true;
              }}
              onCompositionEnd={() => {
                compositionActiveRef.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                if (
                  isImeComposingKeyEvent({
                    compositionActive: compositionActiveRef.current,
                    nativeEvent: event.nativeEvent,
                  })
                ) {
                  // 中文输入法 Enter 是候选确认，不是提交。
                  return;
                }
                event.preventDefault();
                submit();
              }}
            />
            <p className="text-ui-sm text-foreground-subtlest">
              {intl.formatMessage(
                { id: "chat.empty.createWorkspace.locationHint" },
                { path: getScratchWorkspaceLocationHint(nameDraft) },
              )}
            </p>
            {errorMessage ? (
              <p role="alert" className="text-ui-base text-destructive">
                {errorMessage}
              </p>
            ) : null}
          </div>
          <DialogFooter className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              disabled={pending}
              onClick={submit}
            >
              {intl.formatMessage({ id: "chat.empty.createWorkspace.confirm" })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
