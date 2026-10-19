import type { McpTrackedProcess, SessionProcessEntry } from "@zcode/adapters";
import type { SessionId, SessionStorePort } from "@zcode/contracts";
import type {
  ZCodeProcessChildProcessesResult,
  ZCodeProcessToolProcess,
} from "@zcode/shared";
import { resolveOfficialPluginNameByHostMcpServerName } from "../app/official-plugin-definitions.js";

/**
 * `process/childProcesses`：把 MCP 进程注册表与工具派生进程登记簿整理成协议结果。
 * 只做归属补齐（builtin host MCP → 官方插件名、会话归属），不做任何 I/O；
 * CPU/内存采样由桌面 Host 完成。
 *
 * 会话归属规则：
 * - MCP 连接只有在“恰好一个会话独占”时才上报会话；多会话共享的连接不报。
 * - 工具派生进程记录的是发起该次执行的会话，天然独占。
 */
export async function listChildProcesses(
  tracked: readonly McpTrackedProcess[],
  toolProcesses: readonly SessionProcessEntry[] = [],
  resolveSessionTitle: (sessionId: string) => Promise<string | undefined> = async () => undefined,
): Promise<ZCodeProcessChildProcessesResult> {
  const titleCache = new Map<string, string | undefined>();
  const titleOf = async (sessionId: string): Promise<string | undefined> => {
    if (!titleCache.has(sessionId)) {
      titleCache.set(sessionId, await resolveSessionTitle(sessionId));
    }
    return titleCache.get(sessionId);
  };

  const processes = await Promise.all(
    tracked.map(async (process) => {
      const pluginName =
        process.pluginName ??
        (process.mcpSource === "builtin"
          ? resolveOfficialPluginNameByHostMcpServerName(process.serverName)
          : undefined);
      const exclusiveSessionId =
        process.sessionIds?.length === 1 ? process.sessionIds[0] : undefined;
      const sessionTitle = exclusiveSessionId ? await titleOf(exclusiveSessionId) : undefined;
      return {
        pid: process.pid,
        serverName: process.serverName,
        mcpSource: process.mcpSource,
        ...(pluginName ? { pluginName } : {}),
        ...(exclusiveSessionId ? { sessionId: exclusiveSessionId } : {}),
        ...(sessionTitle ? { sessionTitle } : {}),
      };
    }),
  );

  const toolProcessRows: ZCodeProcessToolProcess[] = await Promise.all(
    toolProcesses.map(async (entry) => {
      const sessionTitle = await titleOf(entry.sessionId);
      return {
        pid: entry.pid,
        sessionId: entry.sessionId,
        ...(sessionTitle ? { sessionTitle } : {}),
      };
    }),
  );

  return {
    processes,
    ...(toolProcessRows.length > 0 ? { toolProcesses: toolProcessRows } : {}),
  };
}

/**
 * 解析会话标题：只读持久化会话行，读不到或标题为空时返回 undefined。
 * 读取失败不能影响进程上报——归属信息只是展示线索。
 */
export async function resolveSessionTitle(
  store: SessionStorePort | undefined,
  sessionId: string,
): Promise<string | undefined> {
  if (!store) return undefined;
  try {
    const session = await store.getSession(sessionId as SessionId);
    const title = session?.title?.trim();
    return title ? title : undefined;
  } catch {
    return undefined;
  }
}
