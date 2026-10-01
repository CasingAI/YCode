import type {
  CommandsListResult,
  CommandCreateParams,
  CommandUpdateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandBuiltinModelOverrideParams,
  CommandModelOverrideParams,
  CommandAgentSource,
  UserCommand,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ICommandsService {
  list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult>;
  writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }>;
  updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }>;
  deleteCommandFile(params: CommandDeleteParams): Promise<void>;
  setCommandEnabled(params: CommandSetEnabledParams): Promise<void>;
  /**
   * 内置命令的模型绑定：按命令名写用户配置 `builtinCommands` 段。
   * `modelSelection` 传 `undefined` 表示「跟随默认」，删除该键。
   * 内置命令是用户级配置，没有 workspace 维度。
   */
  setBuiltinCommandModelOverride(params: CommandBuiltinModelOverrideParams): Promise<void>;
  /**
   * 用户自定义命令的模型绑定：只重写命令 md 文件头的 model / model-effort 键，
   * description 与 prompt 原样保留。`modelSelection` 为 undefined 即删除两个键。
   */
  setCommandModelOverride(params: CommandModelOverrideParams): Promise<void>;
  getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }>;
}

export const ICommandsService = createServiceDescriptor<ICommandsService>(ServiceChannels.Commands);
