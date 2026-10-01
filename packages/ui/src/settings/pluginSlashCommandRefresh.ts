import type { FileBackedCommand, ZCodeSlashCommand } from "@zcode/shared";

function normalizeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

function slashCommandKey(name: string): string {
  return normalizeSlashCommandName(name).toLowerCase();
}

function commandToSlashCommand(command: FileBackedCommand): ZCodeSlashCommand | null {
  if (!command.enabled) {
    return null;
  }

  const name = normalizeSlashCommandName(command.name);
  if (!name) {
    return null;
  }

  return {
    name,
    description: command.description ?? "",
    inputHint: command.argumentHint ? `/${name} ${command.argumentHint}` : `/${name}`,
    source: "custom",
    // 插件同步等场景重建 custom 条目时必须带上文件头绑定，否则 `/` 面板的
    // 命令着色会静默消失，直到下一次完整目录水合才恢复。绑定只存在于
    // UserCommand；插件文件属安装目录会被升级覆写，与目录投影同因不携带绑定。
    ...(command.source === "user" && command.modelSelectionOverride
      ? { modelSelectionOverride: command.modelSelectionOverride }
      : {}),
  };
}

export function mergeSlashCommandsAfterCommandRefresh(
  currentSlashCommands: readonly ZCodeSlashCommand[],
  refreshedCommands: readonly FileBackedCommand[],
): ZCodeSlashCommand[] {
  const preservedCommands = currentSlashCommands.filter((command) => command.source !== "custom");
  const preservedNames = new Set(
    preservedCommands.map((command) => slashCommandKey(command.name)).filter(Boolean),
  );
  const customCommands: ZCodeSlashCommand[] = [];
  const seenCustomNames = new Set<string>();

  for (const command of refreshedCommands) {
    const slashCommand = commandToSlashCommand(command);
    if (!slashCommand) {
      continue;
    }

    const key = slashCommandKey(slashCommand.name);
    if (!key || preservedNames.has(key) || seenCustomNames.has(key)) {
      continue;
    }

    seenCustomNames.add(key);
    customCommands.push(slashCommand);
  }

  return [...preservedCommands, ...customCommands];
}
