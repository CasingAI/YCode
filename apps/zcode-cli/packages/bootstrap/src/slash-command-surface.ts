import {
  APP_ONLY_BUILTIN_SLASH_COMMANDS,
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES,
} from "@zcode/shared";

const EXTRA_RESERVED_SLASH_COMMAND_NAMES = [
  "compress",
  ...APP_ONLY_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
] as const;

const RESERVED_SLASH_COMMAND_NAMES = new Set(
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.flatMap((entry) => [
    entry.name,
    ...(entry.aliases ?? []),
  ]).concat([...EXTRA_RESERVED_SLASH_COMMAND_NAMES]),
);

function normalizeZCodeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isReservedZCodeSlashCommandName(name: string): boolean {
  return RESERVED_SLASH_COMMAND_NAMES.has(normalizeZCodeSlashCommandName(name));
}
