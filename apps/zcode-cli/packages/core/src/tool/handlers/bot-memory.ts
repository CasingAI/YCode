import { homedir } from "node:os";
import { join } from "node:path";
import {
  BOT_MEMORY_TOOL_NAME,
  BotMemoryInputJsonSchema,
  BotMemoryInputSchema,
  BotMemoryOutputJsonSchema,
  BotMemoryOutputSchema,
  CoreErrorType,
  createCoreError,
  isFileSystemPortError,
  type BotMemoryOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const BOT_MEMORY_DESCRIPTION = [
  "Read or write this Bot's long-term notes file.",
  "This is not a project file. Do not use Read or Write.",
  "Housekeeping may update notes without speaking to the user.",
].join("\n");

export function resolveBotNotesAbsolutePath(botId: string): string {
  const root =
    process.env.ZCODE_HOME?.trim() ||
    process.env.ZCODE_DATA_BASE_DIR?.trim() ||
    join(homedir(), ".zcode");
  return join(root, "bots", botId, "memory.md");
}

const botMemoryHandler: ToolHandler = async (input, context) => {
  const parsed = BotMemoryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_memory requires a valid action", {
      recoverable: true,
      context: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  if (parsed.data.action === "write" && !parsed.data.text?.trim()) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_memory write requires text", {
      recoverable: true,
    });
  }
  if (parsed.data.action === "write" && !parsed.data.text?.trim()) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_memory write requires text", {
      recoverable: true,
    });
  }
  const botId = context.botId?.trim();
  if (!botId) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_memory requires a Bot identity", {
      recoverable: false,
    });
  }
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for bot_memory",
      { recoverable: false },
    );
  }
  const path = resolveBotNotesAbsolutePath(botId);
  if (parsed.data.action === "read") {
    try {
      const read = await fileSystemPort.readTextFile(
        { path },
        { signal: context.abortSignal },
      );
      return { path, text: read.content } satisfies BotMemoryOutput;
    } catch (error) {
      if (isFileSystemPortError(error) && error.code === "not_found") {
        return { path, text: "" } satisfies BotMemoryOutput;
      }
      throw error;
    }
  }
  const text = parsed.data.text ?? "";
  await fileSystemPort.writeTextFile(
    { path, content: text, createParents: true },
    { signal: context.abortSignal },
  );
  return { path, text } satisfies BotMemoryOutput;
};

export const botMemoryToolEntry: ToolEntry = {
  capability: "Read and write this Bot's long-term notes file",
  metadata: {
    name: BOT_MEMORY_TOOL_NAME,
    description: BOT_MEMORY_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 10_000,
    maxOutputBytes: 40_000,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: botMemoryHandler,
  inputSchema: BotMemoryInputJsonSchema,
  outputSchema: BotMemoryOutputJsonSchema,
  runtimeInputSchema: BotMemoryInputSchema,
  runtimeOutputSchema: BotMemoryOutputSchema,
  permission: {
    permission: "session.botMemory",
    reason: "bot_memory only reads and writes this Bot's notes file",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 40_000,
    maxModelBytes: 40_000,
    strategy: "truncate",
    preview: { maxBytes: 8_000, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "bot_memory was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
