import { create } from "zustand";
import type {
  BuiltinCommand,
  CommandCreateParams,
  CommandDeleteParams,
  CommandModelOverrideParams,
  CommandSetEnabledParams,
  CommandUpdateParams,
  FileBackedCommand,
  ModelSelection,
  PluginCommand,
  UserCommand,
} from "@zcode/shared";
import type { ICommandsService } from "@zcode/services";

interface CommandsStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  commands: FileBackedCommand[];
  userCommands: UserCommand[];
  pluginCommands: PluginCommand[];
  builtinCommands: BuiltinCommand[];
  capability: { userScopeAvailable: boolean };
  loading: boolean;
  error: string | null;
  operatingCommandId: string | null;
  initialize: (
    workspacePath: string | undefined,
    commandsService: ICommandsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (commandsService: ICommandsService) => Promise<void>;
  createCommand: (
    params: CommandCreateParams,
    commandsService: ICommandsService,
  ) => Promise<UserCommand | null>;
  updateCommand: (
    params: CommandUpdateParams,
    commandsService: ICommandsService,
  ) => Promise<UserCommand | null>;
  deleteCommand: (
    params: CommandDeleteParams,
    commandsService: ICommandsService,
  ) => Promise<boolean>;
  toggleCommand: (
    params: CommandSetEnabledParams,
    commandsService: ICommandsService,
  ) => Promise<void>;
  setBuiltinCommandModelOverride: (
    params: { name: string; modelSelection?: ModelSelection },
    commandsService: ICommandsService,
  ) => Promise<void>;
  setCommandModelOverride: (
    params: CommandModelOverrideParams,
    commandsService: ICommandsService,
  ) => Promise<void>;
}

const inflightLists = new Map<string, Promise<void>>();

type StoreGet = () => CommandsStoreState;

function listKey(workspacePath: string | undefined, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath || "__no_workspace__";
}

// store 是单例，Scope 菜单可在同一页面切换 target。任何异步结果写回之前都要比对
// 发起时的 target key，否则慢 target 的列表会覆盖当前投影，随后 delete/toggle 会拿着旧 host
// 的 filePath 在当前 target 的 host 上执行。
function currentListKey(get: StoreGet): string {
  const { workspacePath, workspaceIdentity } = get();
  return listKey(workspacePath ?? undefined, workspaceIdentity ?? undefined);
}

export const useCommandsStore = create<CommandsStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  commands: [],
  userCommands: [],
  pluginCommands: [],
  builtinCommands: [],
  capability: { userScopeAvailable: true },
  loading: false,
  error: null,
  operatingCommandId: null,

  initialize: async (workspacePath, commandsService, workspaceIdentity) => {
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    set({ workspacePath: workspacePath ?? null, workspaceIdentity: normalizedWorkspaceIdentity });
    const key = listKey(workspacePath, normalizedWorkspaceIdentity ?? undefined);
    const existing = inflightLists.get(key);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      set({ loading: true, error: null });
      try {
        const result = await commandsService.list({
          workspacePath,
          ...(normalizedWorkspaceIdentity
            ? { workspaceIdentity: normalizedWorkspaceIdentity }
            : {}),
        });
        if (currentListKey(get) !== key) return;
        set({
          commands: result.commands,
          userCommands: result.userCommands,
          pluginCommands: result.pluginCommands,
          // 旧版本 agent/协议的 list 响应可能缺失 builtinCommands 字段；直接透传会把
          // store 默认 [] 覆盖成 undefined，设置页命令分区读取 .length 时崩溃。
          builtinCommands: result.builtinCommands ?? [],
          capability: result.capability,
          loadedWorkspacePath: workspacePath ?? null,
          loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
          loading: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (currentListKey(get) !== key) return;
        set({ loading: false, error: message });
      } finally {
        inflightLists.delete(key);
      }
    })();
    inflightLists.set(key, promise);
    await promise;
  },

  refresh: async (commandsService) => {
    const { workspacePath, workspaceIdentity } = get();
    const key = currentListKey(get);
    set({ loading: true, error: null });
    try {
      const result = await commandsService.list({
        workspacePath: workspacePath ?? undefined,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (currentListKey(get) !== key) return;
      set({
        commands: result.commands,
        userCommands: result.userCommands,
        pluginCommands: result.pluginCommands,
        // 同 initialize：list 响应缺失 builtinCommands 时回退空数组，避免 undefined.length 崩溃。
        builtinCommands: result.builtinCommands ?? [],
        capability: result.capability,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentity,
        loading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (currentListKey(get) !== key) return;
      set({ loading: false, error: message });
    }
  },

  createCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ error: null });
    try {
      const { command } = await commandsService.writeCommandFile(params);
      // 写入在发起时的 target host 上已完成，但期间若切了 Scope，
      // 结果不能再合并进当前 target 的投影，否则列表混入别的 host 的命令。
      if (currentListKey(get) !== key) return command;
      const { commands, userCommands } = get();
      set({
        commands: [...commands, command],
        userCommands: [...userCommands, command],
      });
      return command;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (currentListKey(get) !== key) throw err;
      set({ error: message });
      throw err;
    }
  },

  updateCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      const { command } = await commandsService.updateCommandFile(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return command;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.map((c) => (c.id === params.commandId ? command : c)),
        userCommands: userCommands.map((c) => (c.id === params.commandId ? command : c)),
        operatingCommandId: null,
      });
      return command;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  deleteCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      await commandsService.deleteCommandFile(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return true;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.filter((c) => c.id !== params.commandId),
        userCommands: userCommands.filter((c) => c.id !== params.commandId),
        operatingCommandId: null,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  toggleCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      await commandsService.setCommandEnabled(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.map((command) =>
          command.id === params.commandId ? { ...command, enabled: params.enabled } : command,
        ),
        userCommands: userCommands.map((command) =>
          command.id === params.commandId ? { ...command, enabled: params.enabled } : command,
        ),
        operatingCommandId: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  setBuiltinCommandModelOverride: async (params, commandsService) => {
    set({ error: null });
    try {
      await commandsService.setBuiltinCommandModelOverride(params);
      // 写盘成功即为提交点；不做过期键清理，直接整表刷新回读磁盘，投影永远与配置一致。
      await get().refresh(commandsService);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  setCommandModelOverride: async (params, commandsService) => {
    set({ error: null });
    try {
      await commandsService.setCommandModelOverride(params);
      // frontmatter 写盘成功即为提交点；整表刷新回读磁盘，行内投影与文件头保持一致。
      await get().refresh(commandsService);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },
}));
