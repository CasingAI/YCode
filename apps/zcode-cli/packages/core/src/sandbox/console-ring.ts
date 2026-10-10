// ============================================================
// Sandbox console 环形缓冲：实例级 console 输出的唯一收集器
// ============================================================
// 每条行带单调 seq 与墙钟 at：后台窗口查询（阶段4）按「该次调用开始 →
// 本次读取时刻」裁剪，可选子串 filter 只作用于行文本。超上限丢最旧的行；
// 单行超长就地截断并标记。

import type { SandboxConsoleLine as SandboxConsoleLineContract } from "@zcode/contracts";
import {
  SANDBOX_CONSOLE_LINE_MAX_BYTES,
  SANDBOX_CONSOLE_RING_MAX_LINES,
} from "./constants.js";

export type SandboxConsoleLine = SandboxConsoleLineContract;

export class SandboxConsoleRing {
  private readonly lines: SandboxConsoleLine[] = [];
  private nextSeq = 1;

  /** console 方法调用的收集入口（多参数按空格拼接，格式对齐 node-repl 的 emit）。 */
  push(method: string, text: string): SandboxConsoleLine {
    const line: SandboxConsoleLine = {
      seq: this.nextSeq++,
      at: Date.now(),
      method,
      text: truncateLine(text),
    };
    this.lines.push(line);
    while (this.lines.length > SANDBOX_CONSOLE_RING_MAX_LINES) this.lines.shift();
    return line;
  }

  /** 当前序号水位（调用开始时记下，交回时以此为下界取增量）。 */
  watermark(): number {
    return this.nextSeq;
  }

  /** 取 seq >= fromSeq 的行（fromSeq 缺席取全部）；filter 只留包含该子串的行。 */
  window(input: { filter?: string; fromSeq?: number; limit?: number } = {}): {
    lines: SandboxConsoleLine[];
    truncated: boolean;
  } {
    const fromSeq = input.fromSeq ?? 1;
    let selected = this.lines.filter((line) => line.seq >= fromSeq);
    if (input.filter !== undefined && input.filter.length > 0) {
      selected = selected.filter((line) => line.text.includes(input.filter as string));
    }
    const limit = input.limit ?? selected.length;
    if (selected.length <= limit) return { lines: [...selected], truncated: false };
    return { lines: selected.slice(selected.length - limit), truncated: true };
  }

  /** eval 结果载荷口径的窗口（consoleLines/consoleTruncated）。 */
  evalWindow(input: { filter?: string; fromSeq?: number; limit?: number } = {}): {
    consoleLines: SandboxConsoleLine[];
    consoleTruncated: boolean;
  } {
    const window = this.window(input);
    return { consoleLines: window.lines, consoleTruncated: window.truncated };
  }

  size(): number {
    return this.lines.length;
  }
}

function truncateLine(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= SANDBOX_CONSOLE_LINE_MAX_BYTES) return text;
  const suffix = "...[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  const budget = SANDBOX_CONSOLE_LINE_MAX_BYTES - suffixBytes;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(codePoints.slice(0, mid).join(""), "utf8") <= budget) low = mid;
    else high = mid - 1;
  }
  return `${codePoints.slice(0, low).join("")}${suffix}`;
}
