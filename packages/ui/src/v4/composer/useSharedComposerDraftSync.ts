import { useCallback, useEffect, useRef } from "react";
import { logger } from "@/logger.js";
import {
  getSharedComposerDraftClientId,
  readSharedComposerDraft,
  subscribeSharedComposerDraft,
  type SharedComposerDraftRecord,
} from "@/v4/composer/sharedComposerDraft.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

/**
 * 共享草稿的同步钩子。
 *
 * 桌面窗口与手机远控端连的是同一个 Host，草稿是同一份：
 * 另一端写入的草稿在这里被拉进本端编辑器。
 *
 * 覆盖规则（按顺序）：
 * 1. 自己写的记录不处理——那是本端自己的回声。
 * 2. 正文与本地草稿相同的不处理——内容已经一致，重复应用只会造成写入回环。
 * 3. 本地编辑器还有未保存输入时不处理——正在打字时不能被另一端覆盖。
 * 4. 其余情况才应用远端版本。
 */
export interface SharedComposerDraftSyncParams {
  /** 工作区身份键：`workspaceIdentity?.trim() || workspacePath`。 */
  workspaceKey: string;
  /** 草稿作用域：会话 id，或草稿态的 "__draft__"。 */
  scopeId: string;
  /** 本地草稿当前正文（最后已知版本）。 */
  getLocalDraftText: () => string;
  /** 本地编辑器是否有未保存输入。 */
  isEditorClean: () => boolean;
  /** 把远端草稿应用到本地。 */
  applyDraft: (draft: V4ComposerDraft) => void;
}

/**
 * 共享草稿的覆盖裁决。
 *
 * 抽成纯函数是为了能直接覆盖规则：规则本身决定了两端会不会互相覆盖、
 * 会不会陷入"应用 → 回写 → 再应用"的回环。
 */
export function shouldApplySharedComposerDraft(params: {
  record: SharedComposerDraftRecord;
  /** 本端客户端标识。 */
  localClientId: string;
  /** 已处理过的正文；null 表示还没建立基线。 */
  seenText: string | null;
  /** 本地编辑器是否有未保存输入。 */
  editorClean: boolean;
}): boolean {
  if (params.record.clientId === params.localClientId) {
    // 自己写的记录：那是本端自己的回声。
    return false;
  }
  const payload = params.record.payload as Partial<V4ComposerDraft> | null;
  if (!payload || typeof payload.text !== "string") {
    return false;
  }
  if (params.seenText !== null && payload.text === params.seenText) {
    // 正文已经一致：重复应用只会引发写入回环。
    return false;
  }
  if (!params.editorClean) {
    // 本地还有没落盘的输入：正在打字时不能被另一端覆盖。
    return false;
  }
  return true;
}

export function useSharedComposerDraftSync(
  params: SharedComposerDraftSyncParams,
): void {
  const { workspaceKey, scopeId } = params;
  const scopeToken = `${workspaceKey}\0${scopeId}`;

  const getLocalDraftTextRef = useRef(params.getLocalDraftText);
  getLocalDraftTextRef.current = params.getLocalDraftText;
  const isEditorCleanRef = useRef(params.isEditorClean);
  isEditorCleanRef.current = params.isEditorClean;
  const applyDraftRef = useRef(params.applyDraft);
  applyDraftRef.current = params.applyDraft;

  // 已处理过的正文：既是"内容是否相同"的判据，也是回环的终止条件。
  const seenTextRef = useRef<string | null>(null);
  const seenScopeRef = useRef<string | null>(null);

  const handleRecord = useCallback((record: SharedComposerDraftRecord) => {
    if (seenScopeRef.current !== scopeToken) {
      seenScopeRef.current = scopeToken;
      seenTextRef.current = getLocalDraftTextRef.current();
    }
    const shouldApply = shouldApplySharedComposerDraft({
      record,
      localClientId: getSharedComposerDraftClientId(),
      seenText: seenTextRef.current,
      editorClean: isEditorCleanRef.current(),
    });
    if (!shouldApply) {
      return;
    }
    const payload = record.payload as Partial<V4ComposerDraft>;
    seenTextRef.current = payload.text ?? null;
    applyDraftRef.current({ ...payload, updatedAt: record.updatedAt } as V4ComposerDraft);
  }, [scopeToken]);

  // 切换作用域时重新建立基线，并拉一次共享草稿：
  // 手机端刚写的草稿在本端切到该会话时就能看到。
  useEffect(() => {
    seenScopeRef.current = scopeToken;
    seenTextRef.current = getLocalDraftTextRef.current();
    let cancelled = false;
    void readSharedComposerDraft(workspaceKey, scopeId)
      .then((record) => {
        if (cancelled || !record) {
          return;
        }
        handleRecord(record);
      })
      .catch((error) => {
        logger.warn("[shared-composer-draft] 拉取共享草稿失败", error);
      });
    return () => {
      cancelled = true;
    };
  }, [handleRecord, scopeId, scopeToken, workspaceKey]);

  // 另一端写入时的实时同步。
  useEffect(() => {
    return subscribeSharedComposerDraft((change) => {
      if (change.scopeId !== scopeId || change.workspaceKey !== workspaceKey) {
        return;
      }
      if (!change.record) {
        return;
      }
      handleRecord(change.record);
    });
  }, [handleRecord, scopeId, workspaceKey]);
}
