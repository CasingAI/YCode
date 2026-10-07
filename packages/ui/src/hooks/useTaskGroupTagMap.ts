import { useEffect, useMemo, useState } from "react";
import type { ZCodeTaskGroup } from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { logger } from "@/logger.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

export interface TaskGroupTagInfo {
  id: string;
  title: string;
  color: ZCodeTaskGroup["color"];
  emoji?: string;
}

/**
 * 任务行分组 Tag 数据源：section 级一次拉取，行级只查表。
 *
 * 对本地 workspace tabs 拉一次 listGroupedTaskViewStructure 原始结构，
 * 建 Map<workspaceKey taskId, group>。失效时机与 membershipVersion 对齐
 * （group 操作走 task_meta_changed → bump，见 useGroupedTaskView 注释）。
 * 远端 scopes 不查；行级排除（pinned/archived/identity）由调用方按行状态过滤。
 *
 * 禁止在行内逐行复用 useFlatTaskGroupMenu 做展示——那是单任务 RPC，N 行即 N 次。
 * 行为见 docs/specs/task-group-emoji-and-row-tag.md。
 */
export function useTaskGroupTagMap(params: {
  workspaceTabs: WorkspaceTabState[];
  enabled?: boolean;
}): ReadonlyMap<string, TaskGroupTagInfo> {
  const { workspaceTabs, enabled = true } = params;
  const services = useBaseWorkspaceServices();
  const localWorkspaceTabs = useLocalWorkspaceScopes({ workspaceTabs });
  const membershipVersion = useTaskListMembershipVersion();
  const [membersByTaskKey, setMembersByTaskKey] = useState<ReadonlyMap<string, TaskGroupTagInfo>>(
    () => new Map(),
  );

  const scopes = useMemo(
    () =>
      localWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      })),
    [localWorkspaceTabs],
  );
  const scopeSignature = useMemo(
    () =>
      scopes
        .map((scope) => buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity))
        .sort()
        .join("|"),
    [scopes],
  );

  useEffect(() => {
    if (!enabled || scopes.length === 0) {
      setMembersByTaskKey(new Map());
      return;
    }
    let cancelled = false;
    void services.zcodeTaskService
      .listGroupedTaskViewStructure({ workspaceScopes: scopes })
      .then((structure) => {
        if (cancelled) {
          return;
        }
        const nextGroupsById = new Map<string, ZCodeTaskGroup>();
        for (const group of structure.groups) {
          nextGroupsById.set(group.id, group);
        }
        const nextMembers = new Map<string, TaskGroupTagInfo>();
        for (const member of structure.members) {
          const group = nextGroupsById.get(member.groupId);
          if (!group) {
            continue;
          }
          nextMembers.set(`${member.workspaceKey} ${member.taskId}`, {
            id: group.id,
            title: group.title,
            color: group.color,
            ...(group.emoji ? { emoji: group.emoji } : {}),
          });
        }
        setMembersByTaskKey(nextMembers);
      })
      .catch((error) => {
        if (!cancelled) {
          logger.error("[useTaskGroupTagMap] 加载分组结构失败", error);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope 身份由 scopeSignature 固定，membershipVersion 驱动失效重拉。
  }, [enabled, membershipVersion, scopeSignature, services.zcodeTaskService]);
  return membersByTaskKey;
}

/** 行级查表：与 timeline 现有 buildTimelineItemKey 同构（workspaceKey:taskId → 内部空格分隔）。 */
export function lookupTaskGroupTag(
  tagMap: ReadonlyMap<string, TaskGroupTagInfo>,
  params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
): TaskGroupTagInfo | null {
  const key = `${buildTaskWorkspaceKey(params.workspacePath, params.workspaceIdentity)} ${params.taskId}`;
  return tagMap.get(key) ?? null;
}
