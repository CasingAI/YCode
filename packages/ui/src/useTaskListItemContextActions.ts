import type { ZCodeProvider } from "@zcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  fileManagerLabel: string;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
  /** 「重新生成标题」。置位占位符 → 发命令 → settle 时清标记并按结果提示。 */
  handleRegenerateTaskTitle: () => Promise<void>;
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  provider,
  intl,
  loadTaskPaths = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  provider?: ZCodeProvider;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  loadTaskPaths?: boolean;
}): TaskListItemContextActionsResult {
  const platform = usePlatform();
  const setTaskTitleGenerating = useZCodeSessionStore((state) => state.setTaskTitleGenerating);
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const services = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // task session/log 路径只用于右键菜单项；菜单未打开时不要在列表重排中批量触发 RPC。
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  const handleCopyText = useCallback(async (label: string, value: string | null) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      logger.info(`[TaskListItem] ${label} 已复制: ${value}`);
    } catch (error) {
      logger.warn("[TaskListItem] 复制文本失败", {
        label,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId || workspaceIdentity?.trim() || workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // 远程项目路径不是宿主机路径。无法精确解析为 WSL 时必须失败关闭，
        // 避免 SSH/Docker 的 Linux 路径误落到原生 Windows、macOS 或 Linux 文件管理器。
        logger.warn("[TaskListItem] 远程 workspace 不支持本机文件管理器", {
          taskId,
          path: workspacePath,
          remoteKind: workspaceOpenTarget.remoteTarget?.kind ?? "unresolved",
        });
        return;
      }

      const result = await platform.openInEditor("explorer", workspacePath, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 WSL workspace 路径失败", {
          taskId,
          path: workspacePath,
          error: result.error ?? "unknown-error",
        });
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, workspacePath);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      // Header / task 菜单里的“Open in Finder”语义应该是打开项目目录。
      // 之前这里误绑到了 task session 文件路径，菜单可用性也跟着 task 快照文件走，
      // 一旦 session 文件还没解析出来，用户会看到 Finder 入口莫名不可用。
      // 这里统一改成始终打开 workspacePath，让行为和“Copy path=项目路径”保持一致。
      logger.warn("[TaskListItem] 打开 workspace 路径失败", {
        taskId,
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
    }
  }, [
    platform,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
    workspacePath,
  ]);

  const handleRegenerateTaskTitle = useCallback(async () => {
    // 先置位再发命令：占位符必须在请求发出之前就亮起来，否则 60s 超时窗口内
    // 用户面对的是一个点完没反应的菜单。
    setTaskTitleGenerating(workspacePath, taskId, true, workspaceIdentity);
    try {
      await services.zcodeTaskService.regenerateTaskTitle({
        taskId,
        workspacePath,
        ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
        // 远端 workspace 的路由身份：通道靠 useWorkspaceServices 绑定，
        // 参数里的 remoteSessionId 供 adapter 选远端 host（与 sendPrompt 同形）。
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
      // 成功不弹 toast：标题已经就地换成新值，再提示一句是噪音。
    } catch (error) {
      logger.warn("[TaskListItem] 重新生成标题失败", {
        taskId,
        workspacePath,
        workspaceIdentity,
        message: error instanceof Error ? error.message : String(error),
      });
      // 失败必须说明原因（docs/specs/session-title-regeneration.md「失败」）：
      // core 对可预期失败抛带 reasonCode 的领域错误，经 v4 failed ACK 上行。services 的
      // ZCodeV4CommandRejectedError 把 reasonCode/原文放进 `detail`——RPC 错误透传白名单
      // 含 detail 不含 ack，跨进程后这是唯一幸存的结构化载体；同进程调用则直接有 ack。
      // 模态展示 reasonCode 对应文案；未知原因回退原文，再退回通用文案。
      const errorRecord = error as {
        ack?: { reasonCode?: string; message?: string };
        detail?: { reasonCode?: string; message?: string };
      };
      const reason = errorRecord.detail ?? errorRecord.ack;
      const descriptionId = {
        "title.modelUnavailable": "taskList.regenerateTitleFailedModelUnavailable",
        "title.noMaterial": "taskList.regenerateTitleFailedNoMaterial",
        "title.emptyResult": "taskList.regenerateTitleFailedEmptyResult",
      }[reason?.reasonCode ?? ""] as string | undefined;
      const description = descriptionId
        ? intl.formatMessage({ id: descriptionId })
        : reason?.message?.trim() || intl.formatMessage({ id: "taskList.regenerateTitleFailed" });
      void requestConfirmation({
        title: intl.formatMessage({ id: "taskList.regenerateTitleFailedTitle" }),
        description,
        confirmLabel: intl.formatMessage({ id: "taskList.regenerateTitleFailedOk" }),
        showCloseButton: true,
        // 纯告知型弹窗：失败原因只有一个出口（知道了），双按钮暗示有第二种选择。
        hideCancel: true,
      });
    } finally {
      // 命令 settle 时 SessionTitleUpdated 已经先于 ACK 到达，真标题已就位，
      // 这里直接清不会闪回旧标题。失败路径同样要清，否则占位符永久卡住。
      setTaskTitleGenerating(workspacePath, taskId, false, workspaceIdentity);
    }
  }, [
    intl,
    remoteSessionId,
    requestConfirmation,
    services.zcodeTaskService,
    setTaskTitleGenerating,
    taskId,
    workspaceIdentity,
    workspacePath,
  ]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel: getFileManagerLabel(intl),
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleRegenerateTaskTitle,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
