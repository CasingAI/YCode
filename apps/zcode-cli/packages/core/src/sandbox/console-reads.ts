import type { SandboxConsoleLine } from "@zcode/contracts";
import type { SandboxExecutionRow } from "./execution-rows.js";
import type { SandboxInstance } from "./instance.js";

interface ConsoleReadEntry {
  instance: SandboxInstance;
  executions: SandboxExecutionRow[];
}

export function readSandboxConsoleWindow(
  entry: ConsoleReadEntry | undefined,
  input: { fromSeq?: number; sinceMs?: number; filter?: string; limit?: number },
): { lines: SandboxConsoleLine[]; truncated: boolean } {
  if (!entry) return { lines: [], truncated: false };
  const window = entry.instance.readConsoleWindow(input);
  if (input.sinceMs === undefined) return window;
  return {
    lines: window.lines.filter((line) => line.at >= input.sinceMs!),
    truncated: window.truncated,
  };
}

export function readSandboxConsoleSnapshot(entry: ConsoleReadEntry | undefined): {
  alive: boolean;
  executions: SandboxExecutionRow[];
  lines: SandboxConsoleLine[];
  truncated: boolean;
} {
  if (!entry) return { alive: false, executions: [], lines: [], truncated: false };
  const window = entry.instance.readConsoleWindow({});
  return {
    alive: true,
    executions: [...entry.executions],
    lines: window.lines,
    truncated: window.truncated,
  };
}
