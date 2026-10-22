import { stripRemoteTargetSecrets } from "@zcode/shared";
import type {
  WindowAppearance,
  WindowWorkspaceSetReport,
  WindowWorkspaceSetState,
} from "@zcode/shared/zcode-protocol-v4";
import { isWorkspaceTab, type TabStoreState } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * 窗口结构快照的构造与比对。
 *
 * 单独成文件是为了让镜像 hook 只保留编排逻辑：
 * 上报内容、签名口径和落地映射必须三处共用同一份实现，否则两端会算出不同的集合。
 */

/**
 * 构造权威端要上报的窗口结构全量快照。
 *
 * 只取窗口结构相关字段：会话消息体、工具调用进度这类高频变化不进入快照，
 * 否则每次流式更新都会推一帧给镜像端。
 */
export function buildWindowWorkspaceReport(
  state: TabStoreState,
  clientRevision: number,
  appearance: WindowAppearance,
): WindowWorkspaceSetReport {
  const sessionStore = useZCodeSessionStore.getState();
  const workspaceTabs = state.tabs.filter(isWorkspaceTab);
  const entries = workspaceTabs.map((tab) => {
    const workspaceState = sessionStore.getWorkspaceState(
      tab.workspacePath,
      tab.workspaceIdentity,
    );
    return {
      id: tab.id,
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity
        ? { workspaceIdentity: tab.workspaceIdentity }
        : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      // 快照会跨进程送到手机端，连接凭据不能跟着走。
      ...(tab.remoteTarget
        ? { remoteTarget: stripRemoteTargetSecrets(tab.remoteTarget) }
        : {}),
      ...(tab.workspacePurpose
        ? { workspacePurpose: tab.workspacePurpose }
        : {}),
      ...(tab.availability ? { availability: tab.availability } : {}),
      activeTaskId: workspaceState.activeTaskId ?? null,
    };
  });
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  return {
    clientRevision,
    entries,
    activeEntryId: activeTab && isWorkspaceTab(activeTab) ? activeTab.id : null,
    activeWorkspacePath: state.activeWorkspacePath,
    activeWorkspaceIdentity: state.activeWorkspaceIdentity,
    expandedWorkspacePaths: Array.from(state.expandedWorkspacePaths),
    appearance,
  };
}

/**
 * 快照内容签名。
 *
 * 只用窗口结构相关字段算签名：会话流式更新会高频改写 sessionStore，
 * 但那些变化不影响窗口结构，不应该触发上报。
 */
export function buildWindowWorkspaceSignature(
  report: WindowWorkspaceSetReport,
): string {
  return JSON.stringify([
    report.entries.map((entry) => [
      entry.id,
      entry.workspacePath,
      entry.workspaceIdentity ?? null,
      entry.remoteSessionId ?? null,
      entry.workspacePurpose ?? null,
      entry.availability ?? null,
      entry.activeTaskId ?? null,
    ]),
    report.activeEntryId,
    report.activeWorkspacePath,
    report.activeWorkspaceIdentity,
    report.expandedWorkspacePaths,
    report.appearance ?? null,
  ]);
}

/** 把协议快照映射成 tabStore 能直接落地的集合。 */
export function toMirroredWorkspaceSet(state: WindowWorkspaceSetState) {
  return {
    revision: state.revision,
    entries: state.entries.map((entry) => ({
      id: entry.id,
      workspacePath: entry.workspacePath,
      ...(entry.workspaceIdentity
        ? { workspaceIdentity: entry.workspaceIdentity }
        : {}),
      ...(entry.remoteSessionId
        ? { remoteSessionId: entry.remoteSessionId }
        : {}),
      ...(entry.remoteTarget
        ? { remoteTarget: entry.remoteTarget as never }
        : {}),
      ...(entry.workspacePurpose
        ? { workspacePurpose: entry.workspacePurpose }
        : {}),
      ...(entry.availability ? { availability: entry.availability } : {}),
    })),
    activeEntryId: state.activeEntryId,
    activeWorkspacePath: state.activeWorkspacePath,
    activeWorkspaceIdentity: state.activeWorkspaceIdentity,
    expandedWorkspacePaths: state.expandedWorkspacePaths,
  };
}
