import { useEffect, useRef, useState } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import {
  buildTaskReadWatermarkKey,
  createTaskSeenReporter,
  registerTaskSeenReporter,
  selectTaskSeenActivityAt,
  type TaskSeenReporter,
} from "@/lib/taskReadWatermark.js";
import { logger } from "@/logger.js";

export interface UseTaskReadWatermarkParams {
  sessionId: string | null;
  snapshot: ConversationSnapshot | null | undefined;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** 主 pane 真实可见；分屏非 focused 仍为 true，forceMount 隐藏 tab 为 false。 */
  visible?: boolean;
  readOnly?: boolean;
  selectionSideChat?: boolean;
  /** conversation 投影窗口已连续接上会话尾部。 */
  contiguousToTail: boolean;
  /** 时间线是否跟随最新；编辑冻结时由调用方再与 editingRowId 组合。 */
  following: boolean;
}

function readDocumentVisible(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState !== "hidden";
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(readDocumentVisible);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const sync = () => setVisible(readDocumentVisible());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

/**
 * 可见终态正文确认已读。
 *
 * 版本只取 `snapshot.lastActivityAt`（与正文同帧发布），绝不用可能领先正文的
 * sessions-index summary，也不用本地 `Date.now()`。分屏/手机 Web 只要 pane 真实可见、
 * 页面可见、连续到 tail 且仍在跟随最新，就向该 workspace Host 上报；切换会话或卸载时
 * 由 reporter 生命周期与 key 隔离，已发出的请求允许自然完成。
 */
export function useTaskReadWatermark(params: UseTaskReadWatermarkParams): void {
  const {
    sessionId,
    snapshot,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    visible = true,
    readOnly = false,
    selectionSideChat = false,
    contiguousToTail,
    following,
  } = params;
  const documentVisible = useDocumentVisible();
  const zcodeTaskService = useZCodeTaskService(
    workspacePath || undefined,
    remoteSessionId ?? null,
    workspaceIdentity ?? null,
  );
  const taskId = snapshot && sessionId && snapshot.sessionId === sessionId ? sessionId : null;
  const watermarkKey =
    taskId && workspacePath
      ? buildTaskReadWatermarkKey({
          taskId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        })
      : null;
  const reporterRef = useRef<TaskSeenReporter | null>(null);

  useEffect(() => {
    if (!watermarkKey || !taskId || !workspacePath || !zcodeTaskService) {
      return;
    }
    const reporter = createTaskSeenReporter({
      send: (seenActivityAt) =>
        zcodeTaskService.setTaskUnread({
          taskId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          unread: false,
          seenActivityAt,
        }),
      onError: (error, seenActivityAt) => {
        logger.warn(
          "[task-read-watermark] 写入已读水位失败",
          {
            taskId,
            workspacePath,
            workspaceIdentity: workspaceIdentity ?? null,
            seenActivityAt,
          },
          error,
        );
      },
    });
    reporterRef.current = reporter;
    const unregister = registerTaskSeenReporter(watermarkKey, reporter);
    return () => {
      unregister();
      reporter.dispose();
      if (reporterRef.current === reporter) {
        reporterRef.current = null;
      }
    };
  }, [taskId, watermarkKey, workspaceIdentity, workspacePath, zcodeTaskService]);

  useEffect(() => {
    if (!taskId) {
      return;
    }
    const seenActivityAt = selectTaskSeenActivityAt({
      snapshot,
      visible,
      documentVisible,
      contiguousToTail,
      following,
      readOnly,
      selectionSideChat,
    });
    if (seenActivityAt === undefined) {
      return;
    }
    reporterRef.current?.report(seenActivityAt);
  }, [
    contiguousToTail,
    documentVisible,
    following,
    readOnly,
    selectionSideChat,
    snapshot,
    taskId,
    visible,
    // 重连或 workspace 切换后 reporter 会重建；主动补发当前可见版本。
    watermarkKey,
    zcodeTaskService,
  ]);
}
