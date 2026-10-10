// task-output.ts 顶到 oxlint max-lines 上限（400 行），把任务投影
// （projectTask 及 dwf / agent 分支）、输出文件尾部快照读取和紧凑文件大小格式化拆到本文件；
// 公开面仍从 task-output.ts 导出。
import { open } from "node:fs/promises";
import type { TaskOutputTask } from "@zcode/contracts";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import { getSandboxInstanceTable } from "../../sandbox/session.js";
import type { ToolExecutionContext } from "../types.js";
import { projectBashTask } from "./task-output-bash.js";

const TASK_OUTPUT_FILE_TAIL_BYTES = 8 * 1024 * 1024;
const TASK_OUTPUT_RUNNING_BASH_PREFIX_BYTES = 30_000;

export function formatCompactFileSize(size: number): string {
  const kilobytes = size / 1024;
  if (kilobytes < 1) return `${size} bytes`;
  if (kilobytes < 1024) return `${trimSingleDecimal(kilobytes)}KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${trimSingleDecimal(megabytes)}MB`;
  return `${trimSingleDecimal(megabytes / 1024)}GB`;
}

function trimSingleDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export async function projectTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
  options?: { consoleFilter?: string },
): Promise<TaskOutputTask> {
  if (task.type === "local_bash") {
    return projectBashTask(task, context, {
      readOutputFile: (outputFile) => readTaskOutputFileSnapshot(outputFile, context),
      runningOutputPrefixBytes: TASK_OUTPUT_RUNNING_BASH_PREFIX_BYTES,
    });
  }
  // 沙盒后台任务：console 窗口 + return 经实例表投影，不走文件；
  // consoleFilter 只作用于沙盒 console 行，其它种类任务忽略该字段。
  if (task.type === "local_sandbox") {
    return projectSandboxTask(task, options?.consoleFilter);
  }
  if (task.type === "local_agent") {
    return projectAgentTask(task, context);
  }
  if (task.type === "local_dynamic_workflow") {
    return projectDynamicWorkflowTask(task, context);
  }

  const output = await readTaskOutputFile(task.outputFile, context);
  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(task.outputFile ? { outputFile: task.outputFile } : {}),
  };
}

/**
 * workflow run 的投影优先读取终态更新时写入的 resultText；只读 outputFile 可能遗漏结果。
 * 文件读取保留为回退，返回形状与 {@link projectAgentTask} 一致。
 */
async function projectDynamicWorkflowTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
): Promise<TaskOutputTask> {
  const outputFile = task.outputFile;
  const output = task.resultText ?? (await readTaskOutputFile(outputFile, context));

  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(outputFile ? { outputFile } : {}),
    ...(task.resultText === undefined ? {} : { result: task.resultText }),
    ...(task.error ? { error: task.error } : {}),
  };
}

async function projectAgentTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
): Promise<TaskOutputTask> {
  const outputFile = task.outputFile;
  const diskOutput = await readTaskOutputFile(outputFile, context);
  const completedOutput = task.output?.status === "completed" ? task.output : undefined;
  const cleanResult = completedOutput?.content.map((block) => block.text).join("\n");
  const output = cleanResult || diskOutput;

  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(outputFile ? { outputFile } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    ...(output ? { result: output } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

/**
 * 沙盒后台任务的投影：console 窗口 + return 经实例表读，不走文件。
 * 未完成：窗口 console（调用开始 → 现在），无 return；完成：return + 窗口 console。
 * consoleFilter 只过滤 console 行；实例已销毁/重置后旧 ID 读失败（error）。
 */
function projectSandboxTask(
  task: RuntimeTaskSnapshot,
  consoleFilter?: string,
): TaskOutputTask {
  const table = getSandboxInstanceTable();
  const snapshot = table.getBackgroundEval(task.taskId);
  if (!snapshot) {
    // 实例死亡（reset/dispose/超 128MB/进程重启）：旧 ID 失败，LocalStorage 仍在。
    return {
      task_id: task.taskId,
      task_type: task.type,
      status: task.status,
      description: task.description,
      output: "",
      error:
        "沙盒实例已销毁：该后台任务的 console 与 return 已不可读（重置、内存超限或会话回收导致），LocalStorage 仍在",
    };
  }
  // 原因与修复依据：条件展开被 lint 判为无用展开，直写两条调用分支。
  const windowInput = consoleFilter === undefined ? {} : { filter: consoleFilter };
  const { consoleLines, consoleTruncated } = table.readConsoleWindowForBackground(
    task.taskId,
    windowInput,
  );
  const consoleText = consoleLines.map((line) => line.text).join("\n");
  const output =
    consoleTruncated && consoleText.length > 0
      ? `[earlier console lines omitted]\n${consoleText}`
      : consoleText;
  const fullOutput =
    snapshot.returnText !== undefined && snapshot.returnText.length > 0
      ? (output.length > 0 ? `${output}\n${snapshot.returnText}` : snapshot.returnText)
      : output;
  // 原因与修复依据：后台完成态同样以成功为准带一次新实例提示（与前台成功态的
  // system-reminder 同文案，拼进 output 文本，不改 TaskOutputTask schema）。
  // 失败态的提示由 error 文本携带（见下）。
  const newInstanceNotice =
    "<system-reminder>这是新沙盒实例：旧堆内存没了，LocalStorage 还在。上一次实例因新建、重置、内存超限或会话回收而销毁。</system-reminder>";
  const withNotice =
    snapshot.isFirstResultOnNewInstance === true && snapshot.status === "completed"
      ? (fullOutput.length > 0 ? `${newInstanceNotice}\n\n${fullOutput}` : newInstanceNotice)
      : fullOutput;
  const failedError =
    snapshot.error !== undefined
      ? (snapshot.isFirstResultOnNewInstance === true
        ? `${snapshot.error.message}\n\n${newInstanceNotice}`
        : snapshot.error.message)
      : undefined;
  return {
    task_id: task.taskId,
    task_type: task.type,
    status: snapshot.status,
    description: task.description,
    output: withNotice,
    ...(snapshot.returnText !== undefined ? { result: snapshot.returnText } : {}),
    ...(failedError !== undefined ? { error: failedError } : {}),
  };
}

async function readTaskOutputFile(
  outputFile: string | undefined,
  context: ToolExecutionContext,
): Promise<string> {
  return (await readTaskOutputFileSnapshot(outputFile, context)).content;
}

async function readTaskOutputFileSnapshot(
  outputFile: string | undefined,
  context: ToolExecutionContext,
): Promise<{ available: boolean; content: string; truncated: boolean }> {
  if (!outputFile) {
    return { available: false, content: "", truncated: false };
  }

  try {
    throwIfAborted(context.abortSignal);
    const handle = await open(outputFile, "r");
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, TASK_OUTPUT_FILE_TAIL_BYTES);
      if (bytesToRead === 0) {
        return { available: true, content: "", truncated: false };
      }

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const start = stat.size - bytesToRead;
      let bytesRead = 0;
      while (bytesRead < bytesToRead) {
        const read = await handle.read(
          buffer,
          bytesRead,
          bytesToRead - bytesRead,
          start + bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      throwIfAborted(context.abortSignal);

      const omittedBytes = stat.size - bytesRead;
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      return {
        available: true,
        content:
          omittedBytes > 0
            ? `[${Math.round(omittedBytes / 1024)}KB of earlier output omitted]\n${content}`
            : content,
        truncated: omittedBytes > 0,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (context.abortSignal.aborted) throwIfAborted(context.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { available: false, content: "", truncated: false };
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new DOMException("Task output wait aborted", "AbortError");
}
