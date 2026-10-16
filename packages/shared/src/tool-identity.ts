export const ZCODE_KNOWN_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "web_search",
  "TodoRead",
  "TodoWrite",
  "GoalRead",
  "AskUserQuestion",
  "SendMessage",
  "RelayToSubagent",
  "Sandbox",
  "JSVM",
  "RespondToCoordinator",
  "TaskOutput",
  "TaskStop",
  "js",
  "js_reset",
  "js_add_node_module_dir",
  "mcp__node_repl__js",
  "mcp__node_repl__js_reset",
  "mcp__node_repl__js_add_node_module_dir",
  "Agent",
  "Task",
  "Skill",
  "CreateWorkflow",
  // 修订入口：登记进 workflow family 让确认窗
  // 按 family 选中运行确认块；工具行侧则按名先分流（resolveRenderer.ts），family 兜底不会吞掉它。
  "AmendWorkflow",
  // wire 名就是 snake_case 的 submit_result（仓库里唯一一个），下划线必须字面在场：
  // 未登记时 UI identity 退回 unknown，动态工作流 actor 的提交会落到 raw fallback renderer。
  "submit_result",
  // 计划工具。**只登记名字，不指定 family**：计划卡在 UI 侧的展示 family 是
  // `switch-mode`（ToolCallPresentationFamily），不属于跨端 ZCodeToolFamily，硬塞一个新
  // family 会让 `family === "switch-mode"` 的调用方（conversationWorkItemGap 的边框、
  // PermissionDialog 的占位文案）认不出新行。family 判空后由 UI 判定兜底接住，
  // 见 docs/specs/plan-card-execute.md 的「渲染分发」一条。
  "CreatePlan",
] as const;

export type ZCodeKnownToolName = (typeof ZCODE_KNOWN_TOOL_NAMES)[number];

export type ZCodeToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "todo"
  | "ask-user-question"
  | "agent"
  | "skill"
  | "goal"
  | "message"
  | "task-control"
  | "node-repl"
  | "workflow";

// CreatePlan 与沙盒工具只登记名字，不属于跨端 ZCodeToolFamily；对应 UI 展示由专用判定处理。
const TOOL_FAMILY_BY_NAME: Partial<Record<ZCodeKnownToolName, ZCodeToolFamily>> = {
  Read: "file-read",
  Write: "file-write",
  Edit: "file-write",
  ApplyPatch: "file-write",
  Bash: "shell",
  Glob: "search",
  Grep: "search",
  WebFetch: "search",
  WebSearch: "search",
  web_search: "search",
  TodoRead: "todo",
  TodoWrite: "todo",
  GoalRead: "goal",
  AskUserQuestion: "ask-user-question",
  SendMessage: "message",
  RelayToSubagent: "message",
  RespondToCoordinator: "message",
  TaskOutput: "task-control",
  // TaskStop 未登记时 UI identity 会退回 unknown，最终落到 raw fallback renderer。
  TaskStop: "task-control",
  js: "node-repl",
  js_reset: "node-repl",
  js_add_node_module_dir: "node-repl",
  // node_repl 由 MCP 暴露，进入 UI 的工具名因此带 MCP 前缀。
  // 若这里只登记旧 built-in 名称，专用 REPL renderer 会退回 unknown fallback。
  mcp__node_repl__js: "node-repl",
  mcp__node_repl__js_reset: "node-repl",
  mcp__node_repl__js_add_node_module_dir: "node-repl",
  Agent: "agent",
  Task: "agent",
  Skill: "skill",
  CreateWorkflow: "workflow",
  AmendWorkflow: "workflow",
  submit_result: "workflow",
};

const TOOL_NAME_BY_LOWER = new Map<string, ZCodeKnownToolName>(
  ZCODE_KNOWN_TOOL_NAMES.map((toolName) => [toolName.toLowerCase(), toolName]),
);

const TOOL_NAME_ALIASES: Readonly<Record<string, ZCodeKnownToolName>> = {
  sendmessage: "RelayToSubagent",
  sandbox: "JSVM",
};

export function normalizeZCodeToolName(
  value: string | null | undefined,
): ZCodeKnownToolName | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  const key = normalized.toLowerCase();
  return TOOL_NAME_ALIASES[key] ?? TOOL_NAME_BY_LOWER.get(key) ?? null;
}

export function getZCodeToolFamilyForName(
  value: string | null | undefined,
): ZCodeToolFamily | null {
  const toolName = normalizeZCodeToolName(value);
  if (!toolName) {
    return null;
  }
  // 只登记名字的工具没有跨端 family，由 UI 的专用分流逻辑处理。
  return TOOL_FAMILY_BY_NAME[toolName] ?? null;
}

export function isZCodeToolFamily(
  value: string | null | undefined,
  family: ZCodeToolFamily,
): boolean {
  return getZCodeToolFamilyForName(value) === family;
}

export function isZCodeFileContentWriteToolName(value: string | null | undefined): boolean {
  return normalizeZCodeToolName(value) === "Write";
}
