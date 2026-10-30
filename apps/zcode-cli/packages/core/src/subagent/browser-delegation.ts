import type {
  BrowserControlPort,
  CollaborationMode,
  Logger,
  McpToolDescriptor,
  SubagentExecutionFence,
} from "@zcode/contracts";
import type { AgentProfile } from "./profile.js";

/**
 * 子代理 Browser Use 授权（docs/specs/subagent-browser-use-delegation.md）。
 *
 * 这里只做两件事：判断父 runtime 是否可以为一次 child execution 签发授权，以及把
 * grant/revoke 的失败收窄成「本轮浏览器不可用」。真正的 grant 表、父子校验和页面 scope
 * 分别归 Protocol broker 与 Main，本模块不保存任何状态。
 */

/** 宿主 node_repl MCP server 与 js 工具的真实身份；名称前缀不能单独作为授权依据。 */
export const SUBAGENT_BROWSER_CONTROL_SERVER_NAME = "node_repl";
export const SUBAGENT_BROWSER_CONTROL_TOOL_NAME = "js";

/** 模型可见工具名；当前宿主 MCP 命名规则固定生成该名称。 */
export const SUBAGENT_BROWSER_CONTROL_MODEL_TOOL_NAME = "mcp__node_repl__js";

export interface SubagentBrowserDelegationEligibility {
  /** 父会话实际执行档位（含 plan 开关的派生结果）。 */
  parentMode: CollaborationMode;
  browserUseEnabled: boolean;
  /** 父宿主是否注入了执行级授权端口。 */
  delegationAvailable: boolean;
  background: boolean;
  executionFence?: SubagentExecutionFence;
  /**
   * SessionStore 是否提供 `renewSubagentExecutionClaim`，供 broker 每次浏览器请求前做
   * 权威 fence 校验。缺省 false：没有权威校验时 grant 只能回退内存判断，不能签发。
   */
  executionFenceValidationAvailable?: boolean;
  builtInExplore: boolean;
  profilePermissionMode: AgentProfile["permissionMode"];
  /** `resolveSubagentPermissionMode` 的最终结果。 */
  childPermissionMode: "readonly" | "yolo";
  /** child runtime 最终注册使用的工具白名单。 */
  childToolAllowlist: readonly string[];
  /** child 借用父启动快照后真实可见的 MCP 工具。 */
  childMcpTools: readonly McpToolDescriptor[];
}

export function exposesHostNodeReplBrowserTool(tools: readonly McpToolDescriptor[]): boolean {
  return tools.some(
    (descriptor) =>
      descriptor.serverName === SUBAGENT_BROWSER_CONTROL_SERVER_NAME &&
      descriptor.toolName === SUBAGENT_BROWSER_CONTROL_TOOL_NAME,
  );
}

/**
 * 授权矩阵（spec「授权矩阵」）：
 *
 * - 父会话 Browser Use 已启用且宿主提供授权端口；
 * - 父会话实际为完全访问（yolo/team），plan/readonly 一律拒绝；
 * - 只允许前台 child，且本次 execution 必须有 SessionStore 执行 fence，并具备
 *   `renewSubagentExecutionClaim` 提供的权威校验回调；
 * - 内置 Explore 永远不授权（按内置来源判定，不按名称）；
 * - profile 自身 permissionMode 为 plan/readonly 时拒绝，有效模式必须是 yolo；
 * - 工具面必须真的包含宿主 node_repl 的 `js`：既要在 child 借用后的 MCP 快照里，
 *   也要在最终白名单里以真实工具名出现。同名自定义工具和仅通配 selector 都不算。
 */
export function canDelegateSubagentBrowserUse(
  input: SubagentBrowserDelegationEligibility,
): boolean {
  if (input.parentMode !== "yolo" && input.parentMode !== "team") return false;
  if (!input.browserUseEnabled || !input.delegationAvailable) return false;
  if (input.background) return false;
  if (!input.executionFence) return false;
  if (input.executionFenceValidationAvailable !== true) return false;
  if (input.builtInExplore) return false;
  if (input.profilePermissionMode === "plan" || input.profilePermissionMode === "readonly") {
    return false;
  }
  if (input.childPermissionMode !== "yolo") return false;
  if (!exposesHostNodeReplBrowserTool(input.childMcpTools)) return false;
  return input.childToolAllowlist.includes(SUBAGENT_BROWSER_CONTROL_MODEL_TOOL_NAME);
}

/** 仅用于日志关联的降采样身份；不得包含 grantId、executionFence 或父 session ID。 */
export interface SubagentBrowserDelegationLogContext {
  agentId: string;
  childSessionId: string;
}

export interface SubagentBrowserGrantHandle {
  readonly grantId: string;
  /** 幂等；只会撤销本次 execution 自己签发的 grant。 */
  revoke(): void;
}

export interface IssueSubagentBrowserGrantInput {
  delegationPort: NonNullable<BrowserControlPort["subagentDelegation"]>;
  parentSessionId: string;
  childSessionId: string;
  agentId: string;
  executionFence: SubagentExecutionFence;
  parentTurnId?: string;
  /**
   * 权威执行有效性校验：broker 在每次带 grant 的浏览器请求下发前 await。缺省时 broker
   * 只能做内存 grant 校验，无法发现 SessionStore 已换 epoch 或 claim 已释放。
   */
  validateExecutionFence?: (fence: SubagentExecutionFence) => Promise<boolean>;
  logger?: Logger;
}

/**
 * 同步签发 grant。父 session 不 active / record 不完整时 broker 会抛错；这里降级为
 * 「本轮 child 没有浏览器能力」，不影响其余子任务执行。
 */
export function issueSubagentBrowserGrant(
  input: IssueSubagentBrowserGrantInput,
): SubagentBrowserGrantHandle | undefined {
  const logContext: SubagentBrowserDelegationLogContext = {
    agentId: input.agentId,
    childSessionId: input.childSessionId,
  };
  let grantId: string;
  try {
    const grant = input.delegationPort.grant({
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      agentId: input.agentId,
      executionFence: input.executionFence,
      ...(input.parentTurnId === undefined ? {} : { parentTurnId: input.parentTurnId }),
      ...(input.validateExecutionFence
        ? { validateExecutionFence: input.validateExecutionFence }
        : {}),
    });
    grantId = grant.grantId;
  } catch (error) {
    // 授权失败是预期降级路径：父 session 已不 active、record 不完整都属于这一类。
    // 不记录 grantId（此时也不存在），只记录可关联的 child/agent 身份。
    input.logger?.debug?.("Subagent browser delegation grant unavailable", {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
      event: "subagent.browser_delegation.grant_unavailable",
      module: "core.subagent",
      status: "failed",
    });
    return undefined;
  }

  let revoked = false;
  return {
    grantId,
    revoke() {
      if (revoked) return;
      revoked = true;
      try {
        input.delegationPort.revoke({
          grantId,
          childSessionId: input.childSessionId,
          executionFence: input.executionFence,
        });
      } catch (error) {
        // revoke 由 broker 幂等处理；这里失败不能覆盖 child 的真实执行结果。
        input.logger?.warn?.("Subagent browser delegation revoke failed", {
          ...logContext,
          error: error instanceof Error ? error.message : String(error),
          event: "subagent.browser_delegation.revoke_failed",
          module: "core.subagent",
          status: "failed",
        });
      }
    },
  };
}
