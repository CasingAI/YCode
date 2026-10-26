/**
 * Host 进程树归属：把整机进程表里的 Host 后代按“最近的已知祖先”归到
 * 基础服务 / 内置插件 / 社区插件，并沿同一棵树继承会话归属。
 *
 * 会话归属是独立的一层：MCP 独占连接与工具派生进程根都带会话，
 * 沿进程树向下继承，让整棵子树都标出“来自哪个会话”。
 */
import { basename } from "node:path";
import {
  formatZCodeAgentProcessName,
  type HostResourceUsageProcess,
  type ZCodeProcessChildProcess,
  type ZCodeProcessToolProcess,
} from "@zcode/shared";
import type { ProcessResourceSample } from "./processResourceSampler.js";

export interface HostResourceUsageAgent {
  pid: number;
  provider: string;
  workspacePath: string;
  /** CLI `process/childProcesses` 的回报；请求失败时为空数组，其后代全部归入 cli */
  children: readonly ZCodeProcessChildProcess[];
  /** 工具（Bash 等）派生进程根 → 会话；用于给进程行标注来源会话 */
  toolProcesses: readonly ZCodeProcessToolProcess[];
}

interface AttributeHostProcessTreeOptions {
  samples: ReadonlyMap<number, ProcessResourceSample>;
  hostPid: number;
  agents: readonly HostResourceUsageAgent[];
  /** Host 直接管理的内置插件进程（如 Windows CUA Helper）：pid → 插件名 */
  builtinPluginPids?: ReadonlyMap<number, string>;
}

type Owner =
  | { kind: "agent"; agent: HostResourceUsageAgent }
  | { kind: "mcp"; child: ZCodeProcessChildProcess }
  | { kind: "builtin"; pluginName: string };

/** 进程归属的会话：进程由某个会话独占时才存在 */
interface ProcessSession {
  sessionId: string;
  sessionTitle?: string;
}

function commandDisplayName(command: string): string {
  const name = basename(command.trim()).replace(/\.exe$/i, "");
  return name || command.trim() || "process";
}

function ownerToRow(
  owner: Owner | undefined,
  sample: ProcessResourceSample,
  isOwnerRoot: boolean,
  session: ProcessSession | undefined,
): HostResourceUsageProcess {
  const cpuPercent = sample.cpuPercent;
  const memoryBytes = sample.rssKb * 1024;
  const sessionFields = session
    ? {
        sessionId: session.sessionId,
        ...(session.sessionTitle ? { sessionTitle: session.sessionTitle } : {}),
      }
    : {};
  if (!owner) {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "base",
      groupKey: "host",
      groupLabel: "host",
      cpuPercent,
      memoryBytes,
      ...sessionFields,
    };
  }
  if (owner.kind === "agent") {
    return {
      pid: sample.pid,
      name: isOwnerRoot
        ? formatZCodeAgentProcessName(owner.agent.provider, owner.agent.workspacePath)
        : commandDisplayName(sample.command),
      category: "base",
      groupKey: "cli",
      groupLabel: "cli",
      cpuPercent,
      memoryBytes,
      ...sessionFields,
    };
  }
  if (owner.kind === "builtin") {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "builtin-plugin",
      groupKey: owner.pluginName,
      groupLabel: owner.pluginName,
      cpuPercent,
      memoryBytes,
      ...sessionFields,
    };
  }
  const { child } = owner;
  const groupLabel = child.pluginName ?? child.serverName;
  return {
    pid: sample.pid,
    name: isOwnerRoot ? child.serverName : commandDisplayName(sample.command),
    // 用户裁决：官方市场插件是内置插件，其余（第三方市场 + 自定义 MCP）全部算社区插件。
    category: child.mcpSource === "builtin" ? "builtin-plugin" : "community-plugin",
    groupKey: `${child.mcpSource}:${groupLabel}`,
    groupLabel,
    cpuPercent,
    memoryBytes,
    ...sessionFields,
  };
}

/**
 * 把 Host 的全部后代按“最近的已知祖先”归属：
 * MCP 根 pid → 对应插件；Agent pid → 基础服务 cli；无归属 → 基础服务 host 子进程。
 * Host 自身不在结果里（它的指标由 main 的 app.getAppMetrics 提供）。
 *
 * 会话归属是独立的一层：MCP 独占连接与工具派生进程根都带会话，
 * 沿进程树向下继承，让整棵子树都标出“来自哪个会话”。
 */
export function attributeHostProcessTree(
  options: AttributeHostProcessTreeOptions,
): HostResourceUsageProcess[] {
  const childrenByParent = new Map<number, number[]>();
  for (const sample of options.samples.values()) {
    const siblings = childrenByParent.get(sample.ppid) ?? [];
    siblings.push(sample.pid);
    childrenByParent.set(sample.ppid, siblings);
  }

  const ownerRoots = new Map<number, Owner>();
  /** 需要以“根名称”展示的已知根（Agent / MCP / 内置插件），工具根不在其中。 */
  const namedOwnerRootPids = new Set<number>();
  /** pid → 该进程（或其子树）归属的会话 */
  const sessionRoots = new Map<number, ProcessSession>();

  const registerNamedOwnerRoot = (pid: number, owner: Owner): void => {
    ownerRoots.set(pid, owner);
    namedOwnerRootPids.add(pid);
  };
  // 工具根只是“归属到某 Agent”的补链证据，不能覆盖更明确的 MCP / 内置插件根。
  const registerFallbackOwnerRoot = (pid: number, owner: Owner): void => {
    if (!ownerRoots.has(pid)) ownerRoots.set(pid, owner);
  };
  const registerFallbackSessionRoot = (pid: number, session: ProcessSession): void => {
    if (!sessionRoots.has(pid)) sessionRoots.set(pid, session);
  };

  // 第一轮只登记明确的 Agent / MCP 根，保证后续工具根补链不会掩盖 MCP 归属。
  for (const agent of options.agents) {
    registerNamedOwnerRoot(agent.pid, { kind: "agent", agent });
    for (const child of agent.children) {
      registerNamedOwnerRoot(child.pid, { kind: "mcp", child });
      if (child.sessionId) {
        sessionRoots.set(child.pid, {
          sessionId: child.sessionId,
          ...(child.sessionTitle ? { sessionTitle: child.sessionTitle } : {}),
        });
      }
    }
  }
  for (const agent of options.agents) {
    for (const toolProcess of agent.toolProcesses) {
      // CLI 已报告的工具根即使因 ppid 重排脱离 Host 子树，也要沿 PPID 递归补入；
      // owner 归到对应 Agent，忽略 session 字段时仍能按树统计资源。
      registerFallbackOwnerRoot(toolProcess.pid, { kind: "agent", agent });
      registerFallbackSessionRoot(toolProcess.pid, {
        sessionId: toolProcess.sessionId,
        ...(toolProcess.sessionTitle ? { sessionTitle: toolProcess.sessionTitle } : {}),
      });
    }
  }
  for (const [pid, pluginName] of options.builtinPluginPids ?? []) {
    registerNamedOwnerRoot(pid, { kind: "builtin", pluginName });
  }

  const rows: HostResourceUsageProcess[] = [];
  const visited = new Set<number>([options.hostPid]);
  const visit = (
    pid: number,
    inheritedOwner: Owner | undefined,
    inheritedSession: ProcessSession | undefined,
  ): void => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const sample = options.samples.get(childPid);
      if (!sample) continue;
      const rootOwner = ownerRoots.get(childPid);
      const owner = rootOwner ?? inheritedOwner;
      const session = sessionRoots.get(childPid) ?? inheritedSession;
      rows.push(ownerToRow(owner, sample, namedOwnerRootPids.has(childPid), session));
      visit(childPid, owner, session);
    }
  };
  visit(options.hostPid, undefined, undefined);

  // Agent 注册表里已知但不在 Host 子树下的进程（极端情况：ppid 被重排为 1）也补进来，避免拓扑丢行。
  for (const [pid, owner] of ownerRoots) {
    if (visited.has(pid)) continue;
    const sample = options.samples.get(pid);
    if (!sample) continue;
    visited.add(pid);
    const session = sessionRoots.get(pid);
    rows.push(ownerToRow(owner, sample, namedOwnerRootPids.has(pid), session));
    visit(pid, owner, session);
  }

  return rows.sort((left, right) => left.pid - right.pid);
}
