import {
  SANDBOX_CONSOLE_LINE_MAX_CHARS,
  SANDBOX_CONSOLE_SNAPSHOT_MAX_LINES,
  SANDBOX_EXECUTION_CODE_MAX_CHARS,
  SANDBOX_EXECUTION_PREVIEW_MAX_CHARS,
  SANDBOX_EXECUTION_ROWS_MAX,
  type SandboxConsoleResult,
  type SandboxEvalResult,
  type SandboxResetResult,
  type SandboxStatusResult,
} from "@zcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";
import type { SessionId } from "@zcode/contracts";
import { getSandboxInstanceTable } from "../../sandbox/session.js";

/**
 * 沙盒活实例存在性投影：只读 hasLiveInstance，不碰实例内容。
 * 状态面板「沙盒」分区、分区的点开入口、已开 tab 的死亡覆盖，三者都读这一个查询。
 * 必须和工具 handler 共用同一份静态导入的进程单例；动态 import 在 CJS 打包后
 * 可能落到另一份空表，查询就会把刚跑完的实例写成死亡。
 */
export async function readSandboxStatus(
  this: AgentRuntimeInternal,
  sessionId: SessionId = this.sessionId as SessionId,
): Promise<SandboxStatusResult> {
  try {
    const table = getSandboxInstanceTable();
    if (table.hasLiveInstance(sessionId)) {
      return { kind: "alive", sessionId: String(sessionId) };
    }
    return { kind: "unavailable", sessionId: String(sessionId) };
  } catch (error) {
    return {
      kind: "read_failed",
      sessionId: String(sessionId),
      code: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 控制台用户 eval（阶段8可交互面）：用户输入一行立刻 eval，不受工具必填说明 /
 * `return` 协议约束；仍进同一活实例。不写 transcript，不包新实例提示。
 * 失败态用协议 kind，不抛错。
 */
export async function evalSandboxForUser(
  this: AgentRuntimeInternal,
  code: string,
  sessionId: SessionId = this.sessionId as SessionId,
): Promise<SandboxEvalResult> {
  try {
    const { evalSandboxForUser } = await import("../../sandbox/user-eval.js");
    const table = getSandboxInstanceTable();
    const outcome = await evalSandboxForUser(table, sessionId, code);
    if (outcome.result.kind === "completed") {
      const lines = outcome.result.consoleLines.map((line) => line.text).join("\n");
      return {
        kind: "completed",
        sessionId: String(sessionId),
        ...(outcome.result.returnText !== undefined
          ? { returnText: outcome.result.returnText }
          : {}),
        console: lines,
        consoleTruncated: outcome.result.consoleTruncated,
        ...(outcome.isFirstResultOnNewInstance ? { isNewInstance: true } : {}),
      };
    }
    if (outcome.result.kind === "failed") {
      return {
        kind: "failed",
        sessionId: String(sessionId),
        code: outcome.result.error.code,
        message: outcome.result.error.message,
      };
    }
    return {
      kind: "failed",
      sessionId: String(sessionId),
      code: "sandbox_unexpected_result",
      message: "沙盒返回了意外的结果形态",
    };
  } catch (error) {
    return {
      kind: "failed",
      sessionId: String(sessionId),
      code: "sandbox_eval_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 控制台重置实例（阶段8可交互面）：销毁实例、LocalStorage 留下；
 * 在途 Sandbox 按失败结算，后台 ID 全失效（实例表 dispose 已收口）。
 */
export async function resetSandboxInstance(
  this: AgentRuntimeInternal,
  sessionId: SessionId = this.sessionId as SessionId,
): Promise<SandboxResetResult> {
  try {
    const table = getSandboxInstanceTable();
    table.dispose(sessionId);
    return { kind: "reset", sessionId: String(sessionId) };
  } catch (error) {
    return {
      kind: "unavailable",
      sessionId: String(sessionId),
      code: error instanceof Error ? error.message : String(error),
    };
  }
}
export async function readSandboxConsole(
  this: AgentRuntimeInternal,
  sessionId: SessionId = this.sessionId as SessionId,
): Promise<SandboxConsoleResult> {
  try {
    const table = getSandboxInstanceTable();
    const snapshot = table.readConsoleSnapshot(sessionId);
    const executions = snapshot.executions.slice(-SANDBOX_EXECUTION_ROWS_MAX).map((row) => ({
      seq: row.seq,
      source: row.source,
      preview: Array.from(row.preview).slice(0, SANDBOX_EXECUTION_PREVIEW_MAX_CHARS + 1).join(""),
      truncated: row.truncated,
      code: Array.from(row.code).slice(0, SANDBOX_EXECUTION_CODE_MAX_CHARS + 1).join(""),
      codeTruncated: row.codeTruncated,
      at: row.at,
    }));
    const lines = snapshot.lines.slice(-SANDBOX_CONSOLE_SNAPSHOT_MAX_LINES).map((line) => ({
      seq: line.seq,
      at: line.at,
      method: line.method,
      text: Array.from(line.text).slice(0, SANDBOX_CONSOLE_LINE_MAX_CHARS).join(""),
    }));
    return {
      kind: "output",
      sessionId: String(sessionId),
      alive: snapshot.alive,
      executions,
      lines,
      truncated: snapshot.truncated,
    };
  } catch (error) {
    return {
      kind: "read_failed",
      sessionId: String(sessionId),
      code: error instanceof Error ? error.message : String(error),
    };
  }
}
