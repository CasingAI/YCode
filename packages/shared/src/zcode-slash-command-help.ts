import type { ZCodeSlashCommand } from "./zcode-task-types-core.js";

export type BuiltinZCodeSlashCommandHelpEntry = {
  aliases?: readonly string[];
  details: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

export const BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES: readonly BuiltinZCodeSlashCommandHelpEntry[] =
  [
    {
      details: [
        "Shows command-center help locally without creating a session or sending a model prompt.",
        "Pass a command name with or without the leading slash for command-specific help.",
      ],
      name: "help",
      summary: "Show this slash command help.",
      usage: "/help [command]",
    },
    {
      details: [
        "Opens a Coding Plan setup picker when called without arguments.",
        "Z.ai and BigModel browser login poll for authorization, then securely save credentials and refresh available models.",
        "Manual API key variants accept the API key as an argument.",
      ],
      name: "login",
      summary: "Set up a Coding Plan provider.",
      usage:
        "/login [zai-coding-plan|bigmodel-coding-plan|zai-coding-plan-api-key <api-key>|bigmodel-coding-plan-api-key <api-key>]",
    },
    {
      details: ["Deletes Z.ai OAuth credentials from the shared ZCode credential store."],
      name: "logout",
      summary: "Remove the shared Z.ai login credentials.",
      usage: "/logout",
    },
    {
      details: ["Runs the core manual compaction path and forwards optional summary instructions."],
      name: "compact",
      summary: "Compact the current conversation with optional instructions.",
      usage: "/compact [instructions]",
    },
    {
      details: [
        "Runs a normal agent turn that inspects the current workspace and creates or updates AGENTS.md.",
        "Existing AGENTS.md files should be edited rather than overwritten.",
        "This command targets the workspace root, not the user default ~/.zcode/AGENTS.md.",
      ],
      name: "init",
      summary: "Create or update workspace AGENTS.md instructions.",
      usage: "/init [notes]",
    },
    {
      details: [
        "Starts a durable expert workflow in yolo mode when called with a task.",
        "Use status, resume, or stop to manage the latest or a named workflow run.",
      ],
      name: "expert",
      summary: "Run or manage the expert workflow.",
      usage: "/expert [status|resume|stop|<task>]",
    },
    {
      aliases: ["variant"],
      details: [
        "In the TUI, type /effort or /variant to open composer suggestions.",
        "Submitting the empty command or list shows the current and selectable efforts as text.",
        "Use a listed level to switch the current session reasoning effort.",
      ],
      name: "effort",
      summary: "Show or switch the current session reasoning effort.",
      usage: "/effort [list|<level>]",
    },
    {
      details: [
        "Lists this session's dynamic workflow runs with their current status and resumability.",
        "cancel without a run id cancels the only in-flight run, or lists candidates when there are several.",
        "resume asks the server; a run the server refuses reports the structured reason.",
      ],
      name: "dwf",
      summary: "List, cancel, or resume dynamic workflow runs.",
      usage: "/dwf [list|cancel [runId]|resume <runId>]",
    },
    {
      details: [
        "In the TUI, opens a checkpoint picker when called without arguments.",
        "Use latest or a specific checkpoint id to bypass the picker.",
      ],
      name: "fork",
      summary: "Fork a new session from a workspace checkpoint.",
      usage: "/fork [latest|checkpointId]",
    },
    {
      aliases: ["language"],
      details: [
        "Shows the current UI locale when called without arguments.",
        "Use auto, en-US, or zh-CN to switch and persist the UI locale.",
      ],
      name: "locale",
      summary: "Show or switch the UI locale.",
      usage: "/locale [auto|en-US|zh-CN]",
    },
    {
      details: [
        "Lists MCP server status by default.",
        "Use connect or disconnect with a configured server name to manage the session connection.",
      ],
      name: "mcp",
      summary: "Show or manage configured MCP servers.",
      usage: "/mcp [list|status|connect <server>|disconnect <server>]",
    },
    {
      aliases: ["plugin"],
      details: [
        "Opens a TUI plugin panel when called without arguments.",
        "Rows show ✓ for enabled plugins and ○ for disabled plugins.",
        "Use enable or disable with a plugin id to persist the switch in user config.",
        "Plugin capability changes apply to new sessions.",
      ],
      name: "plugins",
      summary: "Open the plugin manager.",
      usage: "/plugins [list|enable <plugin>|disable <plugin>]",
    },
    {
      details: [
        "Shows the current permission mode when submitted without arguments.",
        "Interactive TUI composer input opens a local picker before submit.",
        "Switchable modes are plan, build, edit, and yolo.",
        "Picker rows and explicit input submit /mode <mode> commands.",
      ],
      name: "mode",
      summary: "Show or switch the current permission mode.",
      usage: "/mode [plan|build|edit|yolo]",
    },
    {
      details: [
        "Shows the current and selectable models when called without arguments or with list.",
        "Use a provider/model id to select a model with its default reasoning effort; use /effort to change the effort.",
      ],
      name: "model",
      summary: "Show or switch the current session model.",
      usage: "/model [list|provider/model]",
    },
    {
      aliases: ["clear"],
      details: ["Starts a fresh root session and resets the TUI session projection."],
      name: "new",
      summary: "Start a fresh session in the TUI.",
      usage: "/new",
    },
    {
      aliases: ["continue"],
      details: [
        "In the TUI, opens a session picker when called without arguments.",
        "Resumes a specific session id when provided.",
        "/continue resumes the latest root session for the current directory.",
      ],
      name: "resume",
      summary: "Resume a saved session.",
      usage: "/resume [sessionId]",
    },
    {
      details: [
        "In the TUI, opens a checkpoint picker when called without arguments.",
        "Use status to show the latest checkpoint, or latest/a checkpoint id to restore directly.",
      ],
      name: "rewind",
      summary: "Inspect or restore workspace checkpoints.",
      usage: "/rewind [latest|checkpointId]",
    },
    {
      details: [
        "Without a name, lists discoverable skills for the current working directory.",
        "With a name, rewrites the next prompt so the Skill tool must load that skill first.",
      ],
      name: "skill",
      summary: "List skills, or force the next prompt to load one.",
      usage: "/skill [<skill-name> [task]]",
    },
    {
      aliases: ["target"],
      details: [
        "Shows the current session goal when called without arguments.",
        "Setting a new objective overwrites an existing goal; replace is an explicit alias.",
        "Use pause, resume, or clear to manage the current goal.",
      ],
      name: "goal",
      summary: "Show or set the current session goal.",
      usage: "/goal [pause|resume|clear|replace <objective>|<objective>]",
    },
  ] as const;

/**
 * App（桌面 / Web 界面）可见的内置命令名。设置页与 CLI 的 `/` 面板共用这份清单；
 * 名字必须能在 BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES 里找到，description/usage 取自 help 条目。
 */
export const APP_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES = ["goal", "compact", "init"] as const;

/** 仅供 App 使用的内置命令，不进 CLI TUI/help surface。 */
export const APP_ONLY_BUILTIN_SLASH_COMMANDS = [
  {
    description: "Switch to Plan mode and optionally send a task.",
    inputHint: "/plan [task]",
    name: "plan",
    source: "builtin",
  },
] as const satisfies readonly ZCodeSlashCommand[];

/**
 * 支持「绑定模型」的内置命令：只有压缩是一次维护轮，语义清楚。
 * init 改为强制跟随默认（详情页只读说明）；goal 走自主续跑（生命周期未定义）、
 * plan 在发送前就被 UI 剥掉命令身份，都不提供绑定入口。
 */
export const MODEL_BINDABLE_BUILTIN_SLASH_COMMAND_NAMES = ["compact"] as const;

export function isModelBindableBuiltinSlashCommandName(name: string): boolean {
  return (MODEL_BINDABLE_BUILTIN_SLASH_COMMAND_NAMES as readonly string[]).includes(
    name.trim().replace(/^\/+/, "").toLowerCase(),
  );
}

/**
 * App 内置命令目录的唯一组装点：help 条目里的可见名字 + App 专属条目。
 * CLI 的协议目录装配与设置页的内置命令合成都从这里读，两边不会漂移。
 */
export function listAppBuiltinSlashCommands(): ZCodeSlashCommand[] {
  const visible = APP_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES.flatMap((name) => {
    const entry = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find((item) => item.name === name);
    if (!entry) return [];
    return [
      {
        description: entry.summary,
        inputHint: entry.usage,
        name: entry.name,
        source: "builtin" as const,
      },
    ];
  });
  return [...visible, ...APP_ONLY_BUILTIN_SLASH_COMMANDS];
}
