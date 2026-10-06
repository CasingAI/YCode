import type { BackgroundBashOutput } from "@zcode/shared";

/**
 * 后台 bash 详情面板的派生读数。纯函数，不碰 React 与 i18n，
 * 这样状态/时长/字节数的判定可以单测，面板只负责画。
 */
export type BackgroundBashViewStatus =
  | "loading"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error";

export interface BackgroundBashOutputView {
  /** 面板第一行显示的命令；执行器没带命令（冷恢复、argv 形态）时回退到 tab 标题。 */
  command: string;
  cwd: string | undefined;
  status: BackgroundBashViewStatus;
  /** 距 startedAt 的毫秒数；没有起点就不显示耗时，而不是显示 0。 */
  elapsedMs: number | undefined;
  stdoutBytes: number | undefined;
  exitCode: number | undefined;
  /** 只有真在跑才给停止入口：终态任务再点停止没有意义。 */
  canStop: boolean;
  truncated: boolean;
  hasOutput: boolean;
}

/**
 * `latest` 为 null 表示首次查询还在途：这和「查到了但输出为空」是两回事，
 * 前者显示加载态，后者显示等待输出的终端提示。
 */
export function backgroundBashViewStatus(
  latest: Pick<BackgroundBashOutput, "status"> | null,
): BackgroundBashViewStatus {
  return latest?.status ?? "loading";
}

export function isBackgroundBashTerminal(status: BackgroundBashViewStatus): boolean {
  return status !== "loading" && status !== "running";
}

/**
 * 运行中用 `now` 走表；终态优先用执行器给的 `completedAt` 定格。
 * Stop 先标 cancelled、结算稍后才完成，那个窗口里 completedAt 还没有，
 * 此时退回 `now`——调用方需要在观察到终态那一刻把 `now` 冻结住，
 * 否则秒表会在任务早已结束后继续爬。
 */
export function backgroundBashElapsedMs(input: {
  latest: Pick<BackgroundBashOutput, "status" | "startedAt" | "completedAt"> | null;
  now: number;
}): number | undefined {
  const startedAt = input.latest?.startedAt;
  if (startedAt === undefined) return undefined;
  const endedAt = isBackgroundBashTerminal(backgroundBashViewStatus(input.latest))
    ? (input.latest?.completedAt ?? input.now)
    : input.now;
  return Math.max(0, endedAt - startedAt);
}

export function backgroundBashOutputView(input: {
  latest: BackgroundBashOutput | null;
  /** 执行器没给命令时的回退文本（tab 标题）。 */
  fallbackTitle: string;
  now: number;
}): BackgroundBashOutputView {
  const { latest, fallbackTitle, now } = input;
  const status = backgroundBashViewStatus(latest);
  const command = latest?.command?.trim();
  return {
    command: command && command.length > 0 ? command : fallbackTitle,
    cwd: latest?.cwd,
    status,
    elapsedMs: backgroundBashElapsedMs({ latest, now }),
    stdoutBytes: latest?.stdoutBytes,
    exitCode: latest?.exitCode,
    canStop: status === "running",
    truncated: latest?.truncated === true,
    hasOutput: (latest?.output.length ?? 0) > 0,
  };
}

export function formatBackgroundBashBytes(bytes: number, locale: string): string {
  if (bytes >= 1024 * 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
      bytes / 1024 / 1024,
    )} MB`;
  }
  if (bytes >= 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
  }
  return `${new Intl.NumberFormat(locale).format(bytes)} B`;
}
