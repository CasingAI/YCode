import type { ZCodeProvider } from "./zcode-task-types-core.js";
import {
  modelGroupIntentSchema,
  modelSelectionSchema,
  type ModelGroupIntent,
  type ModelSelection,
} from "./model-selection.js";

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

/**
 * 内置子代理存储层键名。Worker（SmartWorker）已随 Team 改版废弃（docs/specs/team-mode.md）：
 * 类型收回两项，agents-state.json 里遗留的 Worker 覆盖键由 Partial Record 天然忽略，不迁移。
 */
export type BuiltInSubagentName = "general-purpose" | "Explore";

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<BuiltInSubagentName, ModelSelection>
>;

export type BuiltInSubagentModelGroupIntentOverrides = Partial<
  Record<BuiltInSubagentName, ModelGroupIntent>
>;

export type PluginSubagentModelSelectionOverrides = Readonly<Record<string, ModelSelection>>;

export type PluginSubagentModelGroupIntentOverrides = Readonly<Record<string, ModelGroupIntent>>;

/** 正式 reader 只接受结构化覆盖，不在读取时解释旧双 map 或重新匹配 Provider。 */
export function parsePluginSubagentModelSelectionOverrides(
  value: unknown,
): PluginSubagentModelSelectionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, candidate]) => {
      const selection = modelSelectionSchema.safeParse(candidate);
      return id.startsWith("plugin:") && selection.success ? [[id, selection.data]] : [];
    }),
  );
}

/** 组意图覆盖 reader（docs/specs/model-group.md）：与具体模型覆盖互斥，调用方按组优先裁决。 */
export function parsePluginSubagentModelGroupIntentOverrides(
  value: unknown,
): PluginSubagentModelGroupIntentOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, candidate]) => {
      const intent = modelGroupIntentSchema.safeParse(candidate);
      return id.startsWith("plugin:") && intent.success ? [[id, intent.data]] : [];
    }),
  );
}

export type AgentPermissionMode = "auto" | "plan" | "readonly" | "yolo";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  /**
   * 模型组意图（docs/specs/model-group.md）：与 modelSelection 互斥，组优先。
   * default / Override 镜像与具体模型三件套同规则：文件默认值、覆盖替换整份意图。
   */
  modelGroupIntent?: ModelGroupIntent;
  defaultModelGroupIntent?: ModelGroupIntent;
  modelGroupIntentOverride?: ModelGroupIntent;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  pluginId?: string;
  pluginName?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface AgentsListResult {
  agents: AgentSummary[];
  userAgents: AgentSummary[];
  pluginAgents: AgentSummary[];
  capability: AgentsCapability;
  diagnostics?: AgentDiagnostic[];
}

/** Agent 配置，用于创建/更新 agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  /** 组意图（docs/specs/model-group.md）：与 modelSelection 互斥，选组即清空具体模型。 */
  modelGroupIntent?: ModelGroupIntent;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

/** Agent 创建参数 */
export interface AgentCreateParams {
  config: SubAgentConfig;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 更新参数 */
export interface AgentUpdateParams {
  agentId: string;
  config: SubAgentConfig;
  oldFilePath?: string;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 删除参数 */
export interface AgentDeleteParams {
  agentId: string;
  filePath: string;
}

export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  modelSelection?: ModelSelection;
  /** 组意图（docs/specs/model-group.md）：与 modelSelection 互斥，调用方保证只传一侧。 */
  modelGroupIntent?: ModelGroupIntent;
}

export interface PluginSubagentModelOverrideParams {
  agentId: string;
  modelSelection?: ModelSelection;
  /** 组意图（docs/specs/model-group.md）：与 modelSelection 互斥，调用方保证只传一侧。 */
  modelGroupIntent?: ModelGroupIntent;
}

/**
 * 插件 subagent 的稳定 id：`plugin:<pluginId>:<裸名小写>`。
 * pluginId 为 `<name>@<marketplace>`，不含版本，插件升级后 id 不变，覆盖随之保留。
 * services 与 CLI bootstrap 都用它做 agents-state.json 的键，必须共用一处实现。
 */
export function createPluginAgentStateId(pluginId: string, agentName: string): string {
  return `plugin:${pluginId}:${agentName.trim().toLowerCase()}`;
}

export function createAgentStateId(input: {
  name: string;
  scope: AgentScope;
  source: AgentSource;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
