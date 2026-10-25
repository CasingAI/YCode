// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================

import type {
  AgentBackgroundedOutput,
  AgentOutput,
  AgentTerminalOutput,
} from "../tools/agent.js";
import type { Model, ModelSelection } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface SubagentRunRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  /**
   * 协议层的附件形状，与 core 的 TurnAttachment 同构但归 contracts 所有：
   * contracts 不能 import core，core 侧映射后再使用。
   */
  attachments?: SubagentAttachment[];
  callerCanReadOutputFile?: boolean;
  workspaceIdentity?: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
  /** Child session 持久写入使用的 fencing token；缺省仅兼容非 Fork 历史运行时。 */
  executionFence?: import("./session-store.port.js").SubagentExecutionFence;
}

export interface SubagentForegroundExecutionControl {
  executionId: string;
  epoch: number;
  isCurrent: () => boolean;
  /** 收口条件读取的 owner 输入句柄；撤销会同步可见。 */
  observePendingInputs?: () => unknown;
  /** 当前父 turn/branch 上仍有效的 Guide 来源。 */
  getYieldRequestIds?: () => readonly string[];
  /** 可在完整模型步骤落库后检查的协作收口条件。 */
  shouldYield?: () => boolean;
  /** 将依赖子执行的控制句柄沿当前 join 链传递。 */
  registerDependent?: (control: SubagentForegroundExecutionControl) => () => void;
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  foregroundExecution?: SubagentForegroundExecutionControl;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny";
  };
}

export interface SubagentLaunchRequest extends SubagentRunRequest {
  runInBackground?: boolean;
}

export type SubagentLaunchOptions = SubagentRunOptions;

export type SubagentStartRequest = SubagentRunRequest;

export interface SubagentStartOptions {
  signal?: AbortSignal;
  /** 后台 child 启动时继承的普通 Model；临时 turn 模型仍禁止进入后台。 */
  model?: Model;
}

export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

export interface SubagentStopOptions {
  signal?: AbortSignal;
}

export interface SubagentSendMessageRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  summary: string;
  message: string;
  /** 终态续跑时带给 child executeTurn 的附件；运行中转向走同一排队消息透传。 */
  attachments?: SubagentAttachment[];
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
  trace: TraceContext;
}

export interface SubagentSendMessageOptions {
  foregroundExecution?: SubagentForegroundExecutionControl;
  signal?: AbortSignal;
  model?: Model;
  modelOverride?: SubagentRunOptions["modelOverride"];
}

export type SubagentSendMessageDelivery =
  | "queued"
  | "steered"
  | "resumed_foreground"
  | "resumed_background";

/**
 * 协议安全的附件类型：与 core `TurnAttachment` / `PendingTurnAttachment`
 * 同构，归 contracts 所有。core 侧按字段逐一映射后使用，
 * 不得跨包 import 实现细节。
 */
export interface SubagentAttachment {
  type: "image" | "file" | "pdf";
  path?: string;
  content?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
  continuation?: AgentTerminalOutput;
}

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";

export interface SubagentTaskSnapshot {
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  notified?: boolean;
}

export interface SubagentPort {
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
}
