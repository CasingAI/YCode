// Command 相关类型定义
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import { submissionModeSchema, type SubmissionMode } from "./zcode-protocol-v4/submission.js";
import type { SettingsDirectoryLocation } from "./settings-source.js";

export type CommandSource = "user" | "plugin" | "builtin";
export type CommandAgentSource = "zcodeAgent";

export interface CommandInfo {
  name: string;
  prompt: string;
  content: string;
  filePath: string;
  description?: string;
  argumentHint?: string;
}

export interface UserCommand extends CommandInfo {
  id: string;
  source: "user";
  agentSource: CommandAgentSource;
  location: SettingsDirectoryLocation;
  enabled: boolean;
  scope: "global" | "project";
  projectPath?: string;
  /** 命令 md 文件头声明的模型绑定；undefined = 跟随会话模型。 */
  modelSelectionOverride?: ModelSelection;
  /**
   * 命令 md 文件头声明的模式绑定；undefined = 跟随当前草稿/会话模式。
   * 与模型绑定各自独立快照、各自独立复原（见 docs/specs/command-model-binding.md）。
   */
  modeOverride?: SubmissionMode;
}

export interface PluginCommand extends Omit<CommandInfo, "filePath"> {
  id: string;
  source: "plugin";
  enabled: boolean;
  pluginName: string;
  pluginMarketplace: string;
  pluginEnabled: boolean;
  scope: "global";
  filePath: string;
}

export type ZCodeCommand = UserCommand | PluginCommand | BuiltinCommand;

/** 文件型命令（用户 markdown / 插件贡献）；内置命令没有文件，不在此列。 */
export type FileBackedCommand = UserCommand | PluginCommand;

/**
 * 编译进 CLI 的运行时命令，没有文件路径、不走 markdown 解析。
 * 设置页只读展示：无开关（`enabled` 恒真）、不可编辑删除（`readOnly`）。
 * 不进 `CommandsListResult.commands`，单独走 `builtinCommands`，
 * 现有 user/plugin 的 scope 过滤与插件分组逻辑不感知它。
 */
export interface BuiltinCommand {
  /** 形如 `builtin:<name>` 的稳定 id；内置命令没有文件，不能用路径做键。 */
  id: string;
  name: string;
  description: string;
  inputHint: string;
  source: "builtin";
  enabled: true;
  readOnly: true;
  /**
   * 命令绑定的模型；`undefined` 表示跟随会话模型（「跟随默认」）。
   * 第一期只有 compact / init 提供绑定入口（见 MODEL_BINDABLE_BUILTIN_SLASH_COMMAND_NAMES），
   * goal / plan 恒为 `undefined`。
   */
  modelSelectionOverride?: ModelSelection;
}

export function isUserCommand(command: ZCodeCommand): command is UserCommand {
  return command.source === "user";
}

export function isPluginCommand(command: ZCodeCommand): command is PluginCommand {
  return command.source === "plugin";
}

export function isBuiltinCommand(command: ZCodeCommand): command is BuiltinCommand {
  return command.source === "builtin";
}

export interface CommandConfig {
  name: string;
  prompt: string;
  description?: string;
  argumentHint?: string;
  filePath?: string;
}

export type CommandStorageLevel = "user" | "project";

export interface CommandsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface CommandsListResult {
  /** 文件型命令（user + plugin）；内置命令单独走 builtinCommands，不混入。 */
  commands: FileBackedCommand[];
  userCommands: UserCommand[];
  pluginCommands: PluginCommand[];
  /** 内置命令独立成组；不进 commands/userCommands/pluginCommands。 */
  builtinCommands: BuiltinCommand[];
  capability: CommandsCapability;
}

export interface CommandCreateParams {
  config: CommandConfig;
  agentSource?: CommandAgentSource;
  storageLevel?: CommandStorageLevel;
  workspacePath?: string;
}

export interface CommandUpdateParams {
  commandId: string;
  config: CommandConfig;
  agentSource?: CommandAgentSource;
  oldFilePath?: string;
  storageLevel?: CommandStorageLevel;
  workspacePath?: string;
}

export interface CommandDeleteParams {
  commandId: string;
  filePath: string;
  agentSource?: CommandAgentSource;
}

export interface CommandSetEnabledParams {
  commandId: string;
  filePath: string;
  enabled: boolean;
  agentSource?: CommandAgentSource;
}

/** 内置命令按名字键（没有文件路径）；`modelSelection` 为 undefined 即「跟随默认」删键。 */
export interface CommandBuiltinModelOverrideParams {
  name: string;
  modelSelection?: ModelSelection;
}

/** 文件型命令按 commandId + filePath 定位（编辑走表单的同一条路径）。 */
export interface CommandModelOverrideParams {
  commandId: string;
  filePath: string;
  /** undefined 即「跟随默认」，从文件头删除 model / model-effort 两个键。 */
  modelSelection?: ModelSelection;
  /**
   * 与 modelSelection 同一次落盘的模式绑定；undefined 即「跟随默认」，删除 mode 键。
   * 缺省（字段不存在）表示本次不碰 mode 键——表单未动模式区时调用方不要传它。
   */
  mode?: SubmissionMode;
}

/**
 * 命令 md 文件头「模型绑定」的字符串 <-> ModelSelection 互转，唯一实现：
 * CLI 侧解析（adapters）与 services 侧读写（commandFileParser）都走这里，两侧永不漂移。
 * 格式是给人手写的：`model: <providerId>/<modelId>` + 可选 `model-effort: <档位>`。
 */
const COMMAND_FRONTMATTER_MODEL_PATTERN = /^([^\s/$]+)\/([^\s/$]+)$/;

export function parseCommandFrontmatterModelSelection(
  model: string | undefined,
  effort?: string | undefined,
): ModelSelection | undefined {
  const trimmedModel = model?.trim();
  if (!trimmedModel) return undefined;
  const match = COMMAND_FRONTMATTER_MODEL_PATTERN.exec(trimmedModel);
  if (!match) return undefined;
  const trimmedEffort = effort?.trim();
  const selection: ModelSelection = {
    providerId: match[1]!,
    modelId: match[2]!,
    ...(trimmedEffort ? { options: { reasoningLevel: trimmedEffort } } : {}),
  };
  // 坏值（档位为空串等）按未绑定处理，不抛——手写文件头以宽容读取为准。
  return modelSelectionSchema.safeParse(selection).success ? selection : undefined;
}

export function formatCommandFrontmatterModelSelection(selection: ModelSelection): {
  model: string;
  effort?: string;
} {
  const effort = selection.options?.reasoningLevel?.trim();
  return {
    model: `${selection.providerId}/${selection.modelId}`,
    ...(effort ? { effort } : {}),
  };
}

/**
 * 命令 md 文件头「模式绑定」的字符串 <-> SubmissionMode 互转，唯一实现：
 * CLI 侧解析（adapters）与 services 侧读写（commandFileParser）都走这里。
 * 大小写不敏感、前后空白忽略；坏值按未绑定处理，不抛——手写文件头以宽容读取为准。
 */
export function parseCommandFrontmatterMode(mode: string | undefined): SubmissionMode | undefined {
  const trimmed = mode?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return submissionModeSchema.safeParse(trimmed).success ? (trimmed as SubmissionMode) : undefined;
}

export function formatCommandFrontmatterMode(mode: SubmissionMode): { mode: string } {
  return { mode };
}
