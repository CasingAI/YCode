import {
  isModelBindableBuiltinSlashCommandName,
  listAppBuiltinSlashCommands,
  parseCommandFrontmatterModelSelection,
  type ModelSelection,
  type ZCodeSlashCommand,
} from "@zcode/shared";
import { createConfig } from "@zcode/adapters/config";
import {
  listZCodeCustomCommands,
  type ListZCodeCustomCommandsOptions,
} from "../custom-commands.js";
import { isReservedZCodeSlashCommandName } from "../slash-command-surface.js";

/**
 * `workflow` 是 zcode-guide 内置插件的自定义命令，随 CLI 打包，不受用户 commandOverrides
 * 影响；工具开关关闭时只能在装配目录时按名剔除。
 */
const DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME = "workflow";

export interface ListProtocolSlashCommandsOptions extends ListZCodeCustomCommandsOptions {
  /**
   * Dynamic Workflow 会话工具开关。**只有显式 false
   * 才剔除** `workflow`：CLI 自身的目录装配（TUI / headless 等独立入口）可以缺席该字段，
   * 必须保持原样。协议服务端一律从 appRuntimePreferences 传入显式布尔。
   */
  dynamicWorkflowEnabled?: boolean;
}

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ZCodeSlashCommand[]> {
  const builtinOverrides = await readBuiltinCommandModelSelectionOverrides(options);
  const builtins = listAppBuiltinSlashCommands().map((command) => {
    // goal / plan 不提供绑定入口；配置里残留旧键也不投影，输入框与设置页两侧一致。
    const modelSelectionOverride = isModelBindableBuiltinSlashCommandName(command.name)
      ? builtinOverrides.get(command.name)
      : undefined;
    return { ...command, ...(modelSelectionOverride ? { modelSelectionOverride } : {}) };
  });
  let customCommands: Awaited<ReturnType<typeof listZCodeCustomCommands>>["commands"] = [];
  try {
    const outcome = await listZCodeCustomCommands(options);
    customCommands = outcome.commands;
  } catch {
    // 自定义命令发现失败不应阻断 session snapshot；保留可执行的内置协议命令。
    customCommands = [];
  }

  return pinWorkflowAfterGoal([
    ...builtins,
    ...customCommands
      .filter((command) => !command.disableNonInteractive)
      .filter((command) => !isReservedZCodeSlashCommandName(command.name))
      // 工具开关关闭：composer 的加号菜单与 `/` 面板都只读这份目录，剔除即两个入口一起消失。开启时后面的 pinWorkflowAfterGoal 继续把它钉在 goal 之后。
      .filter(
        (command) =>
          options.dynamicWorkflowEnabled !== false ||
          command.name !== DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME,
      )
      .map((command) => {
        // 文件头的 model / model-effort 在这里转成绑定；坏值按未绑定处理。
        // 只投影 zcode 目录（设置页可编辑）的绑定：plugin 文件属安装目录会被升级
        // 覆写、agents 为外部导入，两者设置页都没有绑定控件——投影了就会出现
        // 「芯片着色但无控件可解除」。判定与设置页 isEditableUserCommand 的
        // location.source === "zcode" 对齐。
        const modelSelectionOverride =
          command.source === "zcode"
            ? parseCommandFrontmatterModelSelection(command.model, command.modelEffort)
            : undefined;
        return {
          description: command.description,
          inputHint: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
          name: command.name,
          source: "custom" as const,
          ...(modelSelectionOverride ? { modelSelectionOverride } : {}),
        };
      }),
  ]);
}

/**
 * 每次目录装配都现读用户配置的 builtinCommands 段：设置页改完绑定，
 * 下一次 readPresentation 即生效，与自定义命令「调用时读文件」的时效一致。
 * 仅用于目录投影（是否展示着色）；「是否仅本轮」由发送端按插入锁定的着色
 * 快照显式声明，执行侧不再开跑现读配置推导。
 */
export async function readBuiltinCommandModelSelectionOverrides(
  options: ListZCodeCustomCommandsOptions = {},
): Promise<Map<string, ModelSelection>> {
  try {
    const { config } = createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      workingDirectory: options.workingDirectory,
    });
    const overrides = new Map<string, ModelSelection>();
    for (const [name, entry] of Object.entries(config.builtinCommandModelSelections ?? {})) {
      overrides.set(name.trim().replace(/^\/+/, "").toLowerCase(), entry.model);
    }
    return overrides;
  } catch {
    // 配置读取失败退化为「无绑定」，不阻断目录装配。
    return new Map();
  }
}

/**
 * App `/` 面板按本目录顺序展示，本函数是唯一的排序点（UI 不维护排序白名单）。
 * `workflow` 是 zcode-guide 内置插件的自定义命令，
 * 按发现顺序会沉在 custom 段末尾；产品要求它与 `goal` 一样作为「开启一段工作」的入口，
 * 紧随 goal 之后。
 * 只调顺序：来源、去重与 reserved 规则不变；任一方缺席时保持原序。
 */
function pinWorkflowAfterGoal(commands: ZCodeSlashCommand[]): ZCodeSlashCommand[] {
  const workflowIndex = commands.findIndex(
    (command) => command.name === DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME,
  );
  if (workflowIndex < 0 || !commands.some((command) => command.name === "goal")) return commands;
  const [workflow] = commands.splice(workflowIndex, 1);
  const goalIndex = commands.findIndex((command) => command.name === "goal");
  commands.splice(goalIndex + 1, 0, workflow!);
  return commands;
}
