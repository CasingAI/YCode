/**
 * 主进程事件循环阻塞诊断报告（诊断用，临时）。
 *
 * 卡顿超阈值时用 process.report 写一份 JSON（活动句柄、资源用量、当前栈），
 * 文件名打回 stdout。注意：报告在解冻后由下一个 tick 触发，抓不到阻塞中的
 * 调用栈，但活动句柄/网络套接字能暴露「谁在 main 上挂着可疑长任务」。
 * 报告仅写入本机临时目录，不上传。
 */
import { readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLogPrefix } from "@zcode/shared";

const REPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export function writeMainEventLoopBlockReport(blockedMs: number): void {
  try {
    const filename = process.report?.writeReport(new Error(`event-loop-blocked~${blockedMs}ms`), {
      directory: tmpdir(),
      filename: `ycode-main-block-${Date.now()}.json`,
    });
    console.warn(
      `${formatLogPrefix("main-watchdog", process.pid)} diagnostic report written: ${filename ?? "process.report unavailable"}`,
    );
    if (filename) {
      // 诊断报告是证据但会堆积；超过保留期的旧报告顺手清掉。
      void readdir(tmpdir())
        .then((entries) =>
          Promise.all(
            entries
              .filter(
                (name) =>
                  name.startsWith("ycode-main-block-") &&
                  name.endsWith(".json") &&
                  Date.now() - Number(name.slice(17, -5)) > REPORT_RETENTION_MS,
              )
              .map((name) => unlink(join(tmpdir(), name)).catch(() => undefined)),
          ),
        )
        .catch(() => undefined);
    }
  } catch (error) {
    console.warn(`${formatLogPrefix("main-watchdog", process.pid)} failed to write report`, error);
  }
}
