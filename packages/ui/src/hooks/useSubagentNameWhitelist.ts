import { useMemo } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useSubagents } from "@/hooks/useSubagents.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";

/**
 * 会话子智能体名白名单（小写集合），供消息气泡判定裸 `@name` 是否可以画成子智能体芯片。
 *
 * 气泡的分词器此前只看 `INLINE_MENTION_TOKEN_PATTERN`，不看子智能体目录，于是
 * `@随手写的词` 也会被染成绿色子智能体芯片。这里给出当前 workspace 真实可用的
 * 子智能体名，未命中的裸 token 按普通文本原样显示。
 *
 * 口径必须复用 `mapSubagentsToMentionItemsForTest`（`@` 面板同一函数）：它含 enabled
 * 过滤与同名优先级折叠，自己遍历 `agents` 会与面板不一致。
 *
 * 目录未就绪（loading）、出错或远端断连（`useSubagents` 此时 `agents` 为空）时返回
 * `undefined`，调用方据此退回修复前的显示：宁可暂时多染色，也不能让历史消息里的
 * `@reviewer` 集体褪色。
 *
 * `useSubagents` 背后有 zustand store 缓存（context + in-flight 去重），同一
 * workspace 无论挂多少消费者只发一次 RPC；但仍只在列表/会话级调用一次，不下沉到逐条消息。
 */
export function useSubagentNameWhitelist(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
  enabled: boolean;
}): ReadonlySet<string> | undefined {
  const { agents, loading, error } = useSubagents(
    options.enabled ? options.workspacePath : null,
    options.provider,
    options.workspaceIdentity,
  );

  return useMemo(() => {
    if (!options.enabled || loading || error || agents.length === 0) return undefined;
    const names = new Set<string>();
    for (const item of mapSubagentsToMentionItemsForTest(agents)) {
      const key = item.value.trim().toLowerCase();
      if (key) names.add(key);
    }
    return names;
  }, [agents, error, loading, options.enabled]);
}
