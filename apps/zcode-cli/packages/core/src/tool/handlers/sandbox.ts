// ============================================================
// Sandbox Tool Handler（History 同级 always-on 系统工具）
// ============================================================
// 权限对齐 Compact（不是 History）：会改会话内存，不能标只读；Ask/Plan 放行
// 必须 allowedInPlanMode + sideEffectScope: session + 免审批 + 非破坏。
// 注册对齐 History：builtInTools 无条件加入，不加 includeX 门。
// handler 只做同步 eval（后台/重置由阶段3/4加字段）；读路径失败、语法错、
// 未接住抛错 → 工具失败，实例留下。新建实例第一次返回包新实例提示（只一次）。

import {
  CoreErrorType,
  SANDBOX_DEFAULT_TIMEOUT_MS,
  SANDBOX_MAX_TIMEOUT_MS,
  SANDBOX_TOOL_NAME,
  SandboxInputJsonSchema,
  SandboxInputSchema,
  SandboxOutputJsonSchema,
  SandboxOutputSchema,
  createCoreError,
  type SandboxOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import { resolveToolWorkingDirectory } from "../path-policy.js";
import { getSandboxInstanceTable } from "../../sandbox/session.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const SANDBOX_TOOL_TIMEOUT_MS = SANDBOX_DEFAULT_TIMEOUT_MS;
const SANDBOX_MAX_MODEL_BYTES = 30_000;

function resolveSandboxTimeoutMs(inputTimeoutMs: number | undefined): number {
  return Math.min(inputTimeoutMs || SANDBOX_DEFAULT_TIMEOUT_MS, SANDBOX_MAX_TIMEOUT_MS);
}

const sandboxHandler: ToolHandler = async (input, context) => {
  const parsed = SandboxInputSchema.parse(input);
  const timeoutMs = resolveSandboxTimeoutMs(parsed.timeout);
  const table = getSandboxInstanceTable();
  const { isAbsolute, resolve } = await import("node:path");
  const filePath =
    parsed.filePath === undefined
      ? undefined
      : isAbsolute(parsed.filePath)
        ? parsed.filePath
        : resolve(
            resolveToolWorkingDirectory(undefined, {
              operation: "execute",
              workingDirectory: context.workingDirectory,
              workspaceRoot: context.workspaceRoot,
            }),
            parsed.filePath,
          );
  const request = {
    sessionId: context.sessionId,
    ...(parsed.code !== undefined ? { code: parsed.code } : {}),
    ...(filePath !== undefined ? { filePath } : {}),
    timeoutMs,
    ...(parsed.reset === true ? { resetBeforeRun: true } : {}),
  };
  // 显式后台：启动即返回 ID（`sandbox_` 前缀），JS 在活实例里继续跑。
  // 登记走既有 BackgroundTaskTracker（status=backgrounded 触发，见 background-tasks.ts）。
  if (parsed.runInBackground === true) {
    const started = await table.startBackgroundEval(request, { signal: context.abortSignal });
    if ("error" in started) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, started.error.message, {
        context: {
          toolCallId: context.toolCallId,
          toolName: SANDBOX_TOOL_NAME,
          code: started.error.code,
        },
        recoverable: true,
      });
    }
    return {
      status: "backgrounded",
      console: "",
      backgroundTaskId: started.taskId,
    } satisfies SandboxOutput;
  }
  // 前台：超时摘的是等待，不是 JS（对齐 Bash auto_on_timeout）。超时后返回后台 ID，
  // JS 在实例里继续跑，TaskOutput 按 ID 取窗口 console + return。
  const outcome = await raceSandboxForeground(request, timeoutMs, context.abortSignal);
  if (outcome.kind === "backgrounded") {
    return {
      status: "backgrounded",
      console: "",
      backgroundTaskId: outcome.taskId,
    } satisfies SandboxOutput;
  }
  if (outcome.result.kind === "failed") {
    // 原因与修复依据：spec「只写这一次（以成功为准）」——新实例第一次若失败，
    // 提示位不消耗，错误文本里携带提示（与成功态的 system-reminder 同文案），
    // 模型在失败里也能看到；下一次成功调用仍带，不重复。
    const message = outcome.isFirstResultOnNewInstance
      ? `${outcome.result.error.message}\n\n<system-reminder>这是新沙盒实例：旧堆内存没了，LocalStorage 还在。上一次实例因新建、重置、内存超限或会话回收而销毁。</system-reminder>`
      : outcome.result.error.message;
    throw createCoreError(CoreErrorType.ToolExecutionFailed, message, {
      context: {
        toolCallId: context.toolCallId,
        toolName: SANDBOX_TOOL_NAME,
        code: outcome.result.error.code,
      },
      recoverable: true,
    });
  }
  const output: SandboxOutput = {
    status: "success",
    ...(outcome.result.returnText !== undefined ? { returnText: outcome.result.returnText } : {}),
    console: outcome.result.consoleLines.map((line) => line.text).join("\n"),
    ...(outcome.result.consoleTruncated ? { consoleTruncated: true } : {}),
    ...(outcome.isFirstResultOnNewInstance ? { isNewInstance: true } : {}),
  };
  return output;
};

// 前台与超时竞速：超时摘的是等待，不是 JS（对齐 Bash auto_on_timeout）。
// 超时后返回后台 ID，JS 在实例里继续跑，TaskOutput 按 ID 取窗口 console + return。
// 调用方 abort 同样摘后台（前台 Stop = 摘后台，卡变为已在后台，JS 继续）。
async function raceSandboxForeground(
  request: {
    sessionId: import("@zcode/contracts").SessionId;
    code?: string;
    filePath?: string;
    timeoutMs: number;
    resetBeforeRun?: boolean;
  },
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<
  | { kind: "foreground"; result: Exclude<import("@zcode/contracts").SandboxEvalResult, { kind: "backgrounded" }>; instanceAlive: boolean; isFirstResultOnNewInstance: boolean }
  | { kind: "backgrounded"; taskId: string }
> {
  const table = getSandboxInstanceTable();
  // 先启动一次后台执行承载 ID（后台登记先行，保证超时/取消时 ID 已存在）；
  // 前台等待同一 taskId 的终态：前台跑完即同步返回，后台条目随之结算（不重复跑源码）。
  const started = await table.startBackgroundEval(request, { signal: abortSignal });
  if ("error" in started) {
    // 参数错误/读文件失败：同步失败，不进后台。
    return {
      kind: "foreground",
      result: { kind: "failed", error: started.error, consoleLines: [], consoleTruncated: false },
      instanceAlive: table.hasLiveInstance(request.sessionId),
      isFirstResultOnNewInstance: false,
    };
  }
  const taskId = started.taskId;
  if (abortSignal.aborted) return { kind: "backgrounded", taskId };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
  });
  const aborted = new Promise<"aborted">((resolve) => {
    if (abortSignal.aborted) resolve("aborted");
    else abortSignal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  try {
    const winner = await Promise.race([table.waitForBackgroundEval(taskId, { signal: abortSignal }).then((snapshot) => ({ kind: "settled" as const, snapshot })), timeout, aborted]);
    if (winner === "timeout" || winner === "aborted") {
      // 超时/取消摘等待：JS 继续跑，返回后台 ID（Stop 摘后台同轨道）。
      return { kind: "backgrounded", taskId };
    }
    const snapshot = winner.snapshot;
    if (!snapshot || snapshot.status === "running") return { kind: "backgrounded", taskId };
    // 前台结算：后台快照转回同步结果（含 console 增量窗口与新实例提示）。
    const window = table.readConsoleWindowForBackground(taskId, {});
    const isFirst = snapshot.isFirstResultOnNewInstance === true;
    if (snapshot.error) {
      return {
        kind: "foreground",
        result: { kind: "failed", error: snapshot.error, ...window },
        instanceAlive: table.hasLiveInstance(request.sessionId),
        isFirstResultOnNewInstance: isFirst,
      };
    }
    return {
      kind: "foreground",
      result: {
        kind: "completed",
        ...(snapshot.returnText !== undefined ? { returnText: snapshot.returnText } : {}),
        ...window,
      },
      instanceAlive: table.hasLiveInstance(request.sessionId),
      isFirstResultOnNewInstance: isFirst,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// 原因与修复依据：对齐 Compact 的放行位（allowedInPlanMode + session + 免审批 +
// 非破坏），Ask/Plan 档放行第一版能力；History 的只读位不适用（会改会话内存）。
const sandboxPermission: ToolPermissionSpec = {
  permission: "session.sandbox.eval",
  reason: "Sandbox runs isolated JS in the session QuickJS instance and its LocalStorage",
  riskLevel: "medium",
  sideEffectScope: "session",
  needsApproval: false,
  patternSources: ["toolName"],
  alwaysAllowPatternSources: ["toolName"],
  denyPriority: "beforeAsk",
};

export const sandboxToolEntry: ToolEntry = {
  capability: "Evaluate JavaScript in the session's isolated QuickJS sandbox",
  metadata: {
    name: SANDBOX_TOOL_NAME,
    description:
      "Run JavaScript in an isolated QuickJS sandbox owned by the current session. In Ask/Plan prefer this over Bash for computation (Bash there is a small command allowlist, not any read-only command). Pass a one-sentence description plus either inline `code` or a `filePath` (mutually exclusive). State assigned to globals persists across calls; LocalStorage persists across restarts. Workspace files use fs.promises (Ask/Plan read-only, Agent may write). Global fetch talks to servers in every Sandbox-capable mode and never asks; WebFetch remains the page-to-markdown tool. No general Node module loader. Load the `sandbox` skill for usage details when it is listed.",
    // 会改会话内存，不能标 readOnly；但它是会话内计算，不设审批（对齐 Compact）。
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: SANDBOX_TOOL_TIMEOUT_MS,
    maxOutputBytes: SANDBOX_MAX_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: sandboxHandler,
  formatModelContent: formatSandboxModelContent,
  inputSchema: SandboxInputJsonSchema,
  outputSchema: SandboxOutputJsonSchema,
  runtimeInputSchema: SandboxInputSchema,
  runtimeOutputSchema: SandboxOutputSchema,
  permission: sandboxPermission,
  resultBudget: {
    maxInlineBytes: SANDBOX_MAX_MODEL_BYTES,
    maxModelBytes: SANDBOX_MAX_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: SANDBOX_MAX_MODEL_BYTES,
      direction: "tail",
    },
  },
  timeout: {
    defaultMs: SANDBOX_DEFAULT_TIMEOUT_MS,
    maxMs: SANDBOX_MAX_TIMEOUT_MS,
    allowCallOverride: true,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    // 原因与修复依据：停止从不打断 JS，前台停止/超时必须摘后台。执行器在无
    // joinOnCancel 时会抢先判取消/超时，handler 交回的 backgrounded 成不了正式
    // 结果（无后台 ID、无 residency 挡回收）。joinOnCancel 让取消只通知收束、
    // 等 handler 交回（同款见 agent.ts / send-message.ts）。
    joinOnCancel: true,
    userVisibleMessage: "Sandbox evaluation was cancelled before a result was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatSandboxModelContent(output: unknown): string {
  const result = SandboxOutputSchema.parse(output);
  // 后台态：给出 ID、说明仍在跑、结果以 TaskOutput 按 ID 读取（带可选 console 子串过滤）。
  // 对齐 Bash backgrounded 文案的“三件套”，措辞与 Bash 可区分（沙盒无输出文件路径）。
  if (result.status === "backgrounded" && result.backgroundTaskId) {
    return `Sandbox evaluation is running in the background with ID: ${result.backgroundTaskId}. It is still running — read windowed console output plus the return value with TaskOutput on that task ID (optional consoleFilter keeps only matching console lines). You will be notified when it completes.`;
  }
  const blocks: string[] = [];
  if (result.isNewInstance === true) {
    // 原因与修复依据：新实例提示走工具返回文本（可包 system-reminder），只写这一次。
    blocks.push(
      "<system-reminder>这是新沙盒实例：旧堆内存没了，LocalStorage 还在。上一次实例因新建、重置、内存超限或会话回收而销毁。</system-reminder>",
    );
  }
  if (result.returnText !== undefined) blocks.push(`<return>\n${result.returnText}\n</return>`);
  if (result.console.trim().length > 0) blocks.push(`<console>\n${result.console}\n</console>`);
  if (blocks.length === 0) return "Sandbox 调用成功，无返回值、无 console 输出。";
  return blocks.join("\n\n");
}
