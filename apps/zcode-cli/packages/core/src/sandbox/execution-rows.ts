// ============================================================
// Sandbox 执行行：控制台 tab 展示行的类型、常量与追加
// ============================================================
// 从 instance-table.ts 拆出（超 400 行门限）：唯一事实源仍是实例表条目的
// executions 列表，本文件只放无状态的类型、常量与纯追加函数，不持有实例。
// 常量与 @zcode/shared 的 sandbox-console.ts 同值（120 字摘要 / 64KiB 全文），
// 两侧逐字段对齐，改一处必须同步另一处。

/** 控制台执行行：每次模型 Sandbox / 用户 eval 一开始追加（不标是否在跑）。 */
export interface SandboxExecutionRow {
  /** 表内单调序号（展示行身份）。 */
  seq: number;
  /** 来源：模型工具调用 / 用户控制台输入（阶段8才有 user）。 */
  source: "model" | "user";
  /** 源码摘要（前 120 字符；超长标记 truncated，全文进只读专用视图）。 */
  preview: string;
  truncated: boolean;
  /** 源码有界全文（只读专用视图的展示源；与 shared 的 64KiB 上限同步，超限截断）。 */
  code: string;
  codeTruncated: boolean;
  /** 开始执行的墙钟（unix ms）。 */
  at: number;
}

/** 执行行摘要上限（字符；默认只露很小几行）。 */
export const SANDBOX_EXECUTION_PREVIEW_MAX_CHARS = 120;
/** 执行行源码全文上限（字符；与 sandboxEval 输入 64KiB 对齐，保持与 shared 同值）。 */
export const SANDBOX_EXECUTION_CODE_MAX_CHARS = 65536;

/** 执行行追加：源码就绪即记（“一开始”）；摘要超长截断并标记，全文有界保留。 */
export function appendSandboxExecutionRow(
  executions: SandboxExecutionRow[],
  nextSeq: number,
  source: SandboxExecutionRow["source"],
  code: string,
): { row: SandboxExecutionRow; nextSeq: number } {
  const chars = Array.from(code);
  const truncated = chars.length > SANDBOX_EXECUTION_PREVIEW_MAX_CHARS;
  const codeChars = Array.from(code);
  const codeTruncated = codeChars.length > SANDBOX_EXECUTION_CODE_MAX_CHARS;
  const row: SandboxExecutionRow = {
    seq: nextSeq,
    source,
    preview: truncated
      ? `${chars.slice(0, SANDBOX_EXECUTION_PREVIEW_MAX_CHARS).join("")}…`
      : code,
    truncated,
    code: codeTruncated
      ? `${codeChars.slice(0, SANDBOX_EXECUTION_CODE_MAX_CHARS).join("")}…`
      : code,
    codeTruncated,
    at: Date.now(),
  };
  executions.push(row);
  return { row, nextSeq: nextSeq + 1 };
}
