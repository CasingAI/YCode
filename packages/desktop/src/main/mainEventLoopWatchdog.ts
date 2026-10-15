/**
 * 主进程事件循环看门狗（诊断用，临时）。
 *
 * 背景：settings 首屏一次复现中，main 与 renderer 同时静默 18.4s、
 * host（stdout 直写）不受影响，判定为 main 被同步任务阻塞导致
 * 日志转发与 IPC 投递全部停摆（docs/specs/model-provider-empty-state.md
 * 关联的启动链路排查）。本模块量化「卡了多久」，卡顿超阈值时用
 * process.report 落一份诊断报告（含主线程调用栈），定位阻塞源。
 */
import { formatLogPrefix } from "@zcode/shared";
import { writeMainEventLoopBlockReport } from "./mainEventLoopBlockReport.js";

const WATCHDOG_INTERVAL_MS = 250;
const LOG_THRESHOLD_MS = 1_000;
const REPORT_THRESHOLD_MS = 3_000;

export function installMainEventLoopWatchdog(): void {
  let lastTickAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const blockedMs = now - lastTickAt - WATCHDOG_INTERVAL_MS;
    lastTickAt = now;
    if (blockedMs < LOG_THRESHOLD_MS) return;
    // console 直写 stdout：走 logger 反而可能又被队列拖延。
    console.warn(
      `${formatLogPrefix("main-watchdog", process.pid)} event loop blocked for ~${blockedMs}ms`,
    );
    if (blockedMs >= REPORT_THRESHOLD_MS) {
      void writeMainEventLoopBlockReport(blockedMs);
    }
  }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
}
