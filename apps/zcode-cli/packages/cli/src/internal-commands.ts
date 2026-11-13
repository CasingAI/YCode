import { ZCODE_BROWSER_HOST_COMMAND } from "@zcode/contracts";

/**
 * Linux CLI 受管浏览器的 idle 启动宿主入口。
 *
 * 只做字面量判断，不加载 Playwright/适配器；main.ts 需要先于 run/bootstrap 分派它。
 */
export function isBrowserHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_BROWSER_HOST_COMMAND;
}

/**
 * Windows 执行 Job 的启动器入口（`__zcode-job-launcher`）。
 *
 * 只做字面量判断，不加载适配器：SEA 单文件无法以 `--eval` 起脚本，必须以本二进制
 * 自 re-exec 并走内部命令分派（与 `__zcode-browser-host` 同机制）。
 */
export function isJobLauncherInvocation(argv: readonly string[]): boolean {
  return argv[0] === "__zcode-job-launcher";
}
