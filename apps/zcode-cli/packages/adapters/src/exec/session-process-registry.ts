/**
 * 工具派生进程 → 会话归属登记簿。
 *
 * 资源管理器要回答“这个进程来自哪个会话”。MCP 连接由连接池的 lease 记录会话，
 * 但 Bash / Hook 等工具派生的进程此前没有任何 pid → 会话记录，Host 只能看到
 * 一棵匿名进程树。这里在执行适配器 spawn 成功时登记根 pid 与发起该次执行的会话，
 * 进程退出时注销；Host 侧按进程树把会话归属继承给后代。
 *
 * 边界：
 * - 本登记簿只认“工具派生的根进程”，不追踪任意孙进程；孙进程由 Host 的进程树继承。
 * - 只在 CLI 进程内存活，不落盘；CLI 退出后归属信息随进程消失。
 * - 条目按 pid 去重：同一 pid 重新登记时以最新会话为准（pid 复用防护依赖 Host 侧比对）。
 */

/** 单条登记：进程根 pid → 会话 id */
export interface SessionProcessEntry {
  pid: number;
  sessionId: string;
}

/**
 * 登记簿容量上限。
 * 正常情况下条目随进程退出被注销；上限只兜住“进程已死但退出事件没送达”的残留。
 */
const MAX_SESSION_PROCESS_ENTRIES = 512;

const entries = new Map<number, string>();

/** 登记工具派生进程根；非法 pid 或空会话 id 直接忽略。 */
export function registerSessionProcess(pid: number, sessionId: string | undefined): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const trimmed = sessionId?.trim();
  if (!trimmed) return;
  if (!entries.has(pid) && entries.size >= MAX_SESSION_PROCESS_ENTRIES) {
    // 超出上限时淘汰最早登记的一条：归属信息只是展示线索，丢掉最旧的不影响正确性。
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  entries.set(pid, trimmed);
}

/** 进程退出后注销；未登记的 pid 静默忽略。 */
export function unregisterSessionProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  entries.delete(pid);
}

/** 当前登记的工具派生进程根。 */
export function listSessionProcesses(): SessionProcessEntry[] {
  return [...entries.entries()].map(([pid, sessionId]) => ({ pid, sessionId }));
}

/** 仅供测试：清空登记簿。 */
export function resetSessionProcessRegistry(): void {
  entries.clear();
}
