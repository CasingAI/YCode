// ============================================================
// Bash Tool - Shell Execution Tool
// ============================================================
// Reference: shell tool input / output shape

import { z } from "zod";
import { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

const MAX_BASH_TIMEOUT_MS = 600_000;
const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "n", "off"]);

/**
 * description 字段的默认提示（英文、不点名语言）。
 *
 * 这是**没有会话语言时**的文案，也必须与本文件改动前逐字节一致——旧会话（或没有语言
 * 的客户端）只能看到它。会话带语言时走 {@link buildBashDescriptionFieldPrompt}。
 */
const BASH_DESCRIPTION_FIELD_PROMPT_DEFAULT = [
  // description 是必填项：UI 用它作为工具卡片的主文案，缺失时只能退回命令原文。
  "Required. Clear, concise description of what this command does in active voice, written in the user's language. Never use words like \"complex\" or \"risk\" in the description - just describe what it does.",
  "",
  "For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):",
  '- ls → "List files in current directory"',
  '- git status → "Show working tree status"',
  '- npm install → "Install package dependencies"',
  "",
  "For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:",
  '- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"',
  '- git reset --hard origin/main → "Discard all local changes and match remote main"',
  "- curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\"",
].join("\n");

/**
 * 会话语点名语言的 description 提示。
 *
 * 只改「用哪种语言」而保留英文示例，等于一边要求中文一边示范英文，模型会跟示例走，
 * 所以示例文案必须整体换成目标语言。en-US 与默认文案的区别只有一处：默认说的是
 * 「用用户的语言」（含糊），这里显式点名 English 并禁止其他语言。
 */
const BASH_DESCRIPTION_FIELD_PROMPT_BY_LANGUAGE: Record<string, string> = {
  "zh-CN": [
    "必填。用主动语态、清晰简洁地描述这条命令做了什么，**必须用简体中文书写，不要使用其他语言**。不要用「复杂」「风险」这类词——只描述它做了什么。",
    "",
    "简单命令（git、npm、标准 CLI 工具）保持简短（5-10 个词）：",
    '- ls → "列出当前目录下的文件"',
    '- git status → "显示工作区状态"',
    '- npm install → "安装包依赖"',
    "",
    "不易一眼看懂的命令（管道、冷门参数等）补充足够上下文，说清它在做什么：",
    '- find . -name "*.tmp" -exec rm {} \\; → "递归查找并删除所有 .tmp 文件"',
    '- git reset --hard origin/main → "丢弃所有本地改动，与远端 main 对齐"',
    "- curl -s url | jq '.data[]' → \"从 URL 获取 JSON 并提取 data 数组元素\"",
  ].join("\n"),
  "en-US": [
    "Required. Clear, concise description of what this command does in active voice, **written in English; do not use any other language**. Never use words like \"complex\" or \"risk\" in the description - just describe what it does.",
    "",
    "For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):",
    '- ls → "List files in current directory"',
    '- git status → "Show working tree status"',
    '- npm install → "Install package dependencies"',
    "",
    "For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:",
    '- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"',
    '- git reset --hard origin/main → "Discard all local changes and match remote main"',
    "- curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\"",
  ].join("\n"),
};

/**
 * 构造 description 字段提示：会话语言已知时点名该语言并附该语言示例，否则回退默认文案。
 *
 * `language` 是会话语言（创建时快照，如 `zh-CN`）；未知或未支持时返回默认英文文案，
 * 调用方不需要自己兜底。
 */
export function buildBashDescriptionFieldPrompt(language?: string): string {
  if (!language) return BASH_DESCRIPTION_FIELD_PROMPT_DEFAULT;
  return BASH_DESCRIPTION_FIELD_PROMPT_BY_LANGUAGE[language] ?? BASH_DESCRIPTION_FIELD_PROMPT_DEFAULT;
}

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const BashInputSchema = z
  .object({
    command: z.string().describe("The command to execute"),
    /**
     * Optional timeout in milliseconds (max 600000)
     */
    timeout: semanticNumber(z.number())
      .optional()
      .describe(`Optional timeout in milliseconds (max ${MAX_BASH_TIMEOUT_MS})`),
    /**
     * 必填。人类可读的命令用途摘要，UI 工具卡片用它作为主文案。
     * Clear, concise description of what this command does in active voice.
     * Never use words like "complex" or "risk" in the description - just describe what it does.
     *
     * For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
     * - ls → "List files in current directory"
     * - git status → "Show working tree status"
     * - npm install → "Install package dependencies"
     *
     * For commands that are harder to parse at a glance (piped commands, obscure flags, etc.),
     * add enough context to clarify what it does:
     * - find . -name "*.tmp" -exec rm {} \; → "Find and delete all .tmp files recursively"
     * - git reset --hard origin/main → "Discard all local changes and match remote main"
     * - curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"
     *
     * 「用哪种语言书写」由会话语言决定，取 `buildBashDescriptionFieldPrompt`；本 schema 里
     * 用的是默认（无语言）文案，provider 可见契约由 `resolveModelContract` 覆盖。
     */
    description: z.string().describe(BASH_DESCRIPTION_FIELD_PROMPT_DEFAULT),
    /**
     * Set to true to run this command in the background. Use Read to read the output later.
     */
    run_in_background: semanticBoolean()
      .optional()
      .describe("Set to true to run this command in the background."),
    /**
     * Set this to true to dangerously override sandbox mode and run commands without sandboxing.
     */
    dangerouslyDisableSandbox: semanticBoolean()
      .optional()
      .describe(
        "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
      ),
  })
  .strict();

export type BashInput = z.infer<typeof BashInputSchema>;

export const BashInputJsonSchema = toToolJsonSchema(BashInputSchema);

function semanticNumber(schema: z.ZodNumber): z.ZodEffects<z.ZodNumber, number, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }, schema);
}

function semanticBoolean(): z.ZodEffects<z.ZodBoolean, boolean, unknown> {
  return z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    if (typeof value !== "string") return value;

    const normalized = value.trim().toLowerCase();
    if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
    if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
    return value;
  }, z.boolean());
}

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface BashOutput {
  /**
   * The standard output of the command
   */
  stdout: string;
  /**
   * The standard error output of the command
   */
  stderr: string;
  /**
   * Structured execution status
   */
  status?: "completed" | "failed" | "timed_out" | "cancelled" | "spawn_error" | "backgrounded";
  /**
   * Process exit code. Non-zero exits are represented here instead of thrown.
   */
  exitCode?: number;
  /**
   * Process exit signal, when available
   */
  signal?: string;
  /**
   * Whether timeout policy stopped the command
   */
  timedOut?: boolean;
  /**
   * Whether cancellation stopped the command
   */
  cancelled?: boolean;
  /**
   * Whether stdout was truncated for inline return
   */
  stdoutTruncated?: boolean;
  /**
   * Whether stderr was truncated for inline return
   */
  stderrTruncated?: boolean;
  /**
   * Total stdout bytes observed
   */
  stdoutBytes?: number;
  /**
   * Total stderr bytes observed
   */
  stderrBytes?: number;
  /**
   * Path to raw output file for large MCP tool outputs
   */
  rawOutputPath?: string;
  /**
   * Whether the command was interrupted
   */
  interrupted: boolean;
  /**
   * Flag to indicate if stdout contains image data
   */
  isImage?: boolean;
  /**
   * ID of the background task if command is running in background
   */
  backgroundTaskId?: string;
  /**
   * True if the user manually backgrounded the command with Ctrl+B
   */
  backgroundedByUser?: boolean;
  /**
   * True if assistant-mode auto-backgrounded a long-running blocking command
   */
  assistantAutoBackgrounded?: boolean;
  /**
   * Flag to indicate if sandbox mode was overridden
   */
  dangerouslyDisableSandbox?: boolean;
  /**
   * Semantic interpretation for non-error exit codes with special meaning
   */
  returnCodeInterpretation?: string;
  /**
   * Whether the command is expected to produce no output on success
   */
  noOutputExpected?: boolean;
  /**
   * Structured content blocks
   */
  structuredContent?: unknown[];
  /**
   * Path to the persisted full output in tool-results dir (set when output is too large for inline)
   */
  persistedOutputPath?: string;
  /**
   * Path to the persisted stdout stream, when stdout was written to an execution artifact.
   */
  stdoutPersistedOutputPath?: string;
  /**
   * Path to the persisted stderr stream, when stderr was written to an execution artifact.
   */
  stderrPersistedOutputPath?: string;
  /**
   * Total size of the output in bytes (set when output is too large for inline)
   */
  persistedOutputSize?: number;
  /**
   * Persisted stdout artifact bytes, when stdout was written to an execution artifact.
   */
  stdoutPersistedOutputSize?: number;
  /**
   * Persisted stderr artifact bytes, when stderr was written to an execution artifact.
   */
  stderrPersistedOutputSize?: number;
  /**
   * Model-facing note listing readFileState entries whose mtime bumped during this command
   */
  staleReadFileStateHint?: string;
  /**
   * gh 命令触发 GitHub API rate limit 时，追加给模型的 system-reminder。
   */
  ghRateLimitHint?: string;
}

export const BashOutputSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    status: z
      .enum(["completed", "failed", "timed_out", "cancelled", "spawn_error", "backgrounded"])
      .optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    timedOut: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    stdoutTruncated: z.boolean().optional(),
    stderrTruncated: z.boolean().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    rawOutputPath: z.string().optional(),
    interrupted: z.boolean(),
    isImage: z.boolean().optional(),
    backgroundTaskId: z.string().optional(),
    backgroundedByUser: z.boolean().optional(),
    assistantAutoBackgrounded: z.boolean().optional(),
    dangerouslyDisableSandbox: z.boolean().optional(),
    returnCodeInterpretation: z.string().optional(),
    noOutputExpected: z.boolean().optional(),
    structuredContent: z.array(z.unknown()).optional(),
    persistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    persistedOutputSize: z.number().int().nonnegative().optional(),
    stdoutPersistedOutputSize: z.number().int().nonnegative().optional(),
    stderrPersistedOutputSize: z.number().int().nonnegative().optional(),
    staleReadFileStateHint: z.string().optional(),
    ghRateLimitHint: z.string().optional(),
    perf: ToolExecutionTelemetrySchema.optional(),
  })
  .strict();

export const BashOutputJsonSchema = toToolJsonSchema(BashOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface BashToolCall {
  id: ToolCallId;
  name: "Bash";
  input: BashInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface BashToolResult {
  toolCallId: ToolCallId;
  output: BashOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Background Task
// -----------------------------------------------

export interface BackgroundTask {
  id: string;
  command: string;
  description?: string;
  startedAt: Date;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  completedAt?: Date;
}

// -----------------------------------------------
// Bash Errors
// -----------------------------------------------

export const BashErrorCode = {
  COMMAND_NOT_PARSABLE: "bash_command_not_parsable",
  COMMAND_TOO_COMPLEX: "bash_command_too_complex",
  COMMAND_INJECTION_RISK: "bash_command_injection_risk",
  READONLY_CHECK_FAILED: "bash_readonly_check_failed",
  UNC_PATH_BLOCKED: "bash_unc_path_blocked",
  HIGH_RISK_COMBINATION: "bash_high_risk_combination",
  SANDBOX_VIOLATION: "bash_sandbox_violation",
  TIMEOUT: "bash_timeout",
  USER_INTERRUPTED: "bash_user_interrupted",
  PROCESS_START_FAILED: "bash_process_start_failed",
  NON_ZERO_EXIT: "bash_non_zero_exit",
  OUTPUT_TOO_LARGE: "bash_output_too_large",
  PERMISSION_DENIED: "bash_permission_denied",
} as const;

export type BashErrorCode = (typeof BashErrorCode)[keyof typeof BashErrorCode];

// -----------------------------------------------
// Shell Permission Types
// -----------------------------------------------

export type ShellPermissionRule = {
  type: "allow" | "deny";
  pattern: string;
  description?: string;
};

export interface ShellPermissionPolicy {
  rules: ShellPermissionRule[];
  allowReadonly: boolean;
  sandboxEnabled: boolean;
  dangerousDisableSandboxAllowed: boolean;
}
